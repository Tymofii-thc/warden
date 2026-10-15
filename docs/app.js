"use strict";

/*
 * Browser port of offchain/scorer/{heuristics,scoreEngine}.ts and
 * sdk/src/decision.ts. Keep the weights, thresholds and flag bits in sync
 * with those files by hand - this page intentionally has no build step, so
 * there is no shared-module import between the Node code and this file.
 */

const NETS = {
  devnet: { rpc: "https://api.devnet.solana.com", label: "devnet" },
  // api.mainnet-beta.solana.com answers 403 to every browser request
  // (checks the Origin header); solana-rpc.publicnode.com does not.
  mainnet: { rpc: "https://solana-rpc.publicnode.com", label: "mainnet-beta" },
};

const FLAGS = {
  SANCTIONED: 1 << 0,
  MIXER_PATTERN: 1 << 1,
  NEW_WALLET: 1 << 2,
  HIGH_VELOCITY: 1 << 3,
  LOW_HISTORY: 1 << 4,
};

// Mirrors offchain/scorer/sampleFlaggedPrograms.ts - ILLUSTRATIVE DEMO DATA
// ONLY, not a real threat-intelligence or sanctions feed.
const SAMPLE_FLAGGED_PROGRAM_IDS = new Set([
  "G5DN8xLS4RPC2kxE3EAqyyVpKQWd4McPsQFZqi1Bc7Eb",
  "HXea3GMpPAwktF95WqheK44CTZNsodbwT4xDp7RKYCvs",
  "JEGvZL3Bnbs62fnj8BPhahdTUCT5yCFLjyg6Brkm9Wqd",
]);

const SIGNATURE_PAGE_SIZE = 1000;
const MAX_SIGNATURES_SCANNED = 1000;
const ONE_DAY_SECONDS = 24 * 60 * 60;
const ALLOW_MAX = 300;
const BLOCK_MIN = 700;
const MAX_SCORE = 1000;

let reqId = 1;

const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The free public RPC endpoints rate-limit aggressively. @solana/web3.js's
// Connection class retries 429s internally by default (which is why the
// Node CLI/demo recovers gracefully); this hand-written fetch wrapper has no
// such safety net unless we add it ourselves, so we do here. A 429 after
// MAX_RETRIES surfaces as a thrown error, which the caller renders as an
// explicit UNSCORED result - never silently treated as a clean screening.
async function rpc(rpcUrl, method, params, attempt = 0) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: reqId++, method, params }),
  });

  if (res.status === 429 || res.status >= 500) {
    if (attempt >= MAX_RETRIES) throw new Error(`RPC HTTP ${res.status} after ${MAX_RETRIES} retries`);
    const retryAfterHeader = Number(res.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : BASE_RETRY_DELAY_MS * 2 ** attempt;
    await sleep(delay);
    return rpc(rpcUrl, method, params, attempt + 1);
  }
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "RPC error");
  return json.result;
}

function daysSince(unixSeconds) {
  return Math.floor((Date.now() / 1000 - unixSeconds) / ONE_DAY_SECONDS);
}

async function getWalletAge(rpcUrl, address) {
  let before;
  let scanned = 0;
  let oldestBlockTime = null;

  while (scanned < MAX_SIGNATURES_SCANNED) {
    const page = await rpc(rpcUrl, "getSignaturesForAddress", [address, { before, limit: SIGNATURE_PAGE_SIZE }]);
    if (!page || page.length === 0) break;

    scanned += page.length;
    const last = page[page.length - 1];
    if (last.blockTime) oldestBlockTime = last.blockTime;
    before = last.signature;

    if (page.length < SIGNATURE_PAGE_SIZE) {
      return { ageDays: oldestBlockTime ? daysSince(oldestBlockTime) : null, signaturesScanned: scanned };
    }
  }
  return { ageDays: oldestBlockTime ? daysSince(oldestBlockTime) : null, signaturesScanned: scanned, cappedOut: true };
}

async function getVelocity(rpcUrl, address) {
  const page = await rpc(rpcUrl, "getSignaturesForAddress", [address, { limit: SIGNATURE_PAGE_SIZE }]);
  const nowSeconds = Date.now() / 1000;
  const last24h = page.filter((s) => s.blockTime && nowSeconds - s.blockTime < ONE_DAY_SECONDS).length;
  const totalObserved = page.length;
  return { last24h, totalObserved, burstRatio: totalObserved > 0 ? last24h / totalObserved : 0 };
}

async function getParsedTx(rpcUrl, signature) {
  return rpc(rpcUrl, "getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
}

function accountKeyString(k) {
  return typeof k === "string" ? k : k.pubkey;
}

async function getCounterpartyFanout(rpcUrl, address, sampleSize = 20) {
  const page = await rpc(rpcUrl, "getSignaturesForAddress", [address, { limit: sampleSize }]);
  const counterparties = new Set();
  let sampled = 0;
  for (const sig of page) {
    const tx = await getParsedTx(rpcUrl, sig.signature);
    if (!tx) continue;
    sampled += 1;
    const keys = (tx.transaction.message.accountKeys || []).map(accountKeyString);
    for (const k of keys) if (k !== address) counterparties.add(k);
  }
  return {
    uniqueCounterparties: counterparties.size,
    transactionsSampled: sampled,
    fanoutRatio: sampled > 0 ? counterparties.size / sampled : 0,
  };
}

async function checkFlaggedProgramInteraction(rpcUrl, address, sampleSize = 20) {
  const page = await rpc(rpcUrl, "getSignaturesForAddress", [address, { limit: sampleSize }]);
  const matched = new Set();
  let sampled = 0;
  for (const sig of page) {
    const tx = await getParsedTx(rpcUrl, sig.signature);
    if (!tx) continue;
    sampled += 1;
    for (const ix of tx.transaction.message.instructions || []) {
      if (ix.programId && SAMPLE_FLAGGED_PROGRAM_IDS.has(ix.programId)) matched.add(ix.programId);
    }
  }
  return { matched: matched.size > 0, matchedProgramIds: [...matched], transactionsSampled: sampled };
}

async function computeRiskScore(rpcUrl, address, onStep) {
  let score = 0;
  let flags = 0;
  const reasons = [];

  onStep("checking wallet age...");
  const age = await getWalletAge(rpcUrl, address);
  if (age.ageDays === null) {
    score += 250;
    flags |= FLAGS.LOW_HISTORY;
    reasons.push("no reachable transaction history (LOW_HISTORY, +250)");
  } else if (age.ageDays < 3) {
    score += 200;
    flags |= FLAGS.NEW_WALLET;
    reasons.push(`wallet age ${age.ageDays}d < 3d (NEW_WALLET, +200)`);
  } else if (age.ageDays < 14) {
    score += 80;
    reasons.push(`wallet age ${age.ageDays}d < 14d (+80, no flag)`);
  } else {
    reasons.push(`wallet age ${age.ageDays}d (no flag)`);
  }

  onStep("checking transaction velocity...");
  const velocity = await getVelocity(rpcUrl, address);
  if (velocity.burstRatio > 0.8 && velocity.totalObserved >= 5) {
    score += 200;
    flags |= FLAGS.HIGH_VELOCITY;
    reasons.push(`burst ratio ${velocity.burstRatio.toFixed(2)} over ${velocity.totalObserved} txs (HIGH_VELOCITY, +200)`);
  }

  onStep("checking counterparty fan-out...");
  const fanout = await getCounterpartyFanout(rpcUrl, address);
  if (fanout.fanoutRatio > 0.9 && fanout.transactionsSampled >= 5) {
    score += 180;
    flags |= FLAGS.MIXER_PATTERN;
    reasons.push(`counterparty fanout ${fanout.fanoutRatio.toFixed(2)} over ${fanout.transactionsSampled} txs (MIXER_PATTERN, +180)`);
  }

  onStep("checking flagged-program interaction...");
  const flaggedProgram = await checkFlaggedProgramInteraction(rpcUrl, address);
  if (flaggedProgram.matched) {
    score += 300;
    flags |= FLAGS.MIXER_PATTERN;
    reasons.push(`touched sample flagged program(s) ${flaggedProgram.matchedProgramIds.join(", ")} (MIXER_PATTERN, +300)`);
  }

  return { score: Math.min(score, MAX_SCORE), flags, reasons };
}

function decisionForScore(score) {
  if (score < ALLOW_MAX) return "ALLOW";
  if (score < BLOCK_MIN) return "REVIEW";
  return "BLOCK";
}

function flagsToNames(flags) {
  return Object.entries(FLAGS)
    .filter(([, bit]) => (flags & bit) !== 0)
    .map(([name]) => name);
}

function looksLikeBase58Pubkey(s) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s.trim());
}

function el(id) { return document.getElementById(id); }

const GAUGE_CIRCUMFERENCE = 2 * Math.PI * 85;
const DECISION_COLOR = { ALLOW: "#35d17a", REVIEW: "#e0b84a", BLOCK: "#e2555a", UNSCORED: "#7d9499" };

function animateGaugeNumber(from, to, ms) {
  const start = performance.now();
  const node = el("gaugeScore");
  function tick(now) {
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - Math.pow(1 - t, 3);
    node.textContent = Math.round(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderGauge(score, decision) {
  const fill = el("gaugeFill");
  const color = DECISION_COLOR[decision] || DECISION_COLOR.UNSCORED;
  const offset = GAUGE_CIRCUMFERENCE * (1 - Math.min(score, MAX_SCORE) / MAX_SCORE);
  fill.style.stroke = color;
  // force a reflow so the transition always plays, even back-to-back
  // eslint-disable-next-line no-unused-expressions
  fill.getBoundingClientRect();
  fill.style.strokeDashoffset = String(offset);
  animateGaugeNumber(0, score, 900);
}

function render(decision, score, flags, reasons) {
  const box = el("result");
  box.hidden = false;
  el("badge").className = `badge ${decision}`;
  el("badge").textContent = decision;
  renderGauge(score, decision);

  const flagsBox = el("flags");
  flagsBox.innerHTML = "";
  const names = flagsToNames(flags);
  if (names.length === 0) {
    flagsBox.innerHTML = `<span class="flag" style="opacity:.6">no flags</span>`;
  } else {
    for (const n of names) {
      const s = document.createElement("span");
      s.className = "flag";
      s.textContent = n;
      flagsBox.appendChild(s);
    }
  }

  const list = el("reasons");
  list.innerHTML = "";
  for (const r of reasons) {
    const li = document.createElement("li");
    li.textContent = r;
    list.appendChild(li);
  }
}

function renderUnscored(message) {
  const box = el("result");
  box.hidden = false;
  el("badge").className = "badge UNSCORED";
  el("badge").textContent = "UNSCORED";
  renderGauge(0, "UNSCORED");
  el("flags").innerHTML = "";
  el("reasons").innerHTML = "";
  const li = document.createElement("li");
  li.textContent = `screening failed: ${message}`;
  el("reasons").appendChild(li);
}

function setStatus(text, isErr) {
  const s = el("status");
  s.textContent = text;
  s.className = isErr ? "status err" : "status";
}

const STEP_KEYS = ["age", "velocity", "fanout", "flagged"];
const STEP_TEXT_MAP = [
  ["checking wallet age", "age"],
  ["checking transaction velocity", "velocity"],
  ["checking counterparty fan-out", "fanout"],
  ["checking flagged-program interaction", "flagged"],
];

function pipelineStepEl(key) {
  return document.querySelector(`.pipe-step[data-step="${key}"]`);
}

function resetPipeline() {
  for (const key of STEP_KEYS) {
    pipelineStepEl(key).className = "pipe-step";
  }
}

function advancePipeline(stepText) {
  const match = STEP_TEXT_MAP.find(([needle]) => stepText.startsWith(needle));
  if (!match) return;
  const key = match[1];
  const idx = STEP_KEYS.indexOf(key);
  for (let i = 0; i < idx; i++) pipelineStepEl(STEP_KEYS[i]).className = "pipe-step done";
  pipelineStepEl(key).className = "pipe-step active";
  return idx;
}

function failPipelineFrom(idx) {
  if (idx == null || idx < 0) return;
  pipelineStepEl(STEP_KEYS[idx]).className = "pipe-step failed";
}

function finishPipeline() {
  for (const key of STEP_KEYS) pipelineStepEl(key).className = "pipe-step done";
}

async function onScreen() {
  const address = el("address").value.trim();
  const net = NETS[el("network").value];
  const btn = el("screenBtn");

  el("result").hidden = true;
  setStatus("");
  resetPipeline();

  if (!looksLikeBase58Pubkey(address)) {
    setStatus("that doesn't look like a base58 Solana address", true);
    return;
  }

  let lastStepIdx = -1;
  btn.disabled = true;
  try {
    const breakdown = await computeRiskScore(net.rpc, address, (step) => {
      lastStepIdx = advancePipeline(step);
      setStatus(`${step} (${net.label})`);
    });
    finishPipeline();
    render(decisionForScore(breakdown.score), breakdown.score, breakdown.flags, breakdown.reasons);
    setStatus(`done - screened against live ${net.label} RPC just now`);
  } catch (err) {
    failPipelineFrom(lastStepIdx);
    renderUnscored(err && err.message ? err.message : String(err));
    setStatus(`screening could not complete on ${net.label} - see UNSCORED result below, this is not a clean result`, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- animated background: a drifting node network ----------

function initBackground() {
  const canvas = el("bgCanvas");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  let w, h, nodes;
  const NODE_COUNT = 46;
  const LINK_DIST = 140;

  function resize() {
    w = canvas.width = window.innerWidth;
    h = canvas.height = window.innerHeight;
  }

  function makeNodes() {
    nodes = Array.from({ length: NODE_COUNT }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
    }));
  }

  function step() {
    ctx.clearRect(0, 0, w, h);
    for (const n of nodes) {
      n.x += n.vx;
      n.y += n.vy;
      if (n.x < 0 || n.x > w) n.vx *= -1;
      if (n.y < 0 || n.y > h) n.vy *= -1;
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < LINK_DIST) {
          ctx.strokeStyle = `rgba(45, 217, 217, ${0.12 * (1 - dist / LINK_DIST)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.stroke();
        }
      }
    }
    for (const n of nodes) {
      ctx.fillStyle = "rgba(45, 217, 217, 0.55)";
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    requestAnimationFrame(step);
  }

  resize();
  makeNodes();
  window.addEventListener("resize", () => {
    resize();
    makeNodes();
  });
  requestAnimationFrame(step);
}

const SAMPLE_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

document.addEventListener("DOMContentLoaded", () => {
  initBackground();
  el("screenBtn").addEventListener("click", onScreen);
  el("address").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onScreen();
  });
  el("trySample").addEventListener("click", () => {
    el("address").value = SAMPLE_ADDRESS;
    onScreen();
  });
});
