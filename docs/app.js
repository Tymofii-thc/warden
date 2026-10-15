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

async function rpc(rpcUrl, method, params) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: reqId++, method, params }),
  });
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

function render(decision, score, flags, reasons) {
  const box = el("result");
  box.hidden = false;
  el("badge").className = `badge ${decision}`;
  el("badge").textContent = decision;
  el("scoreline").innerHTML = `risk score <b>${score}</b> / 1000`;

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
  el("scoreline").textContent = "";
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

async function onScreen() {
  const address = el("address").value.trim();
  const net = NETS[el("network").value];
  const btn = el("screenBtn");

  el("result").hidden = true;
  setStatus("");

  if (!looksLikeBase58Pubkey(address)) {
    setStatus("that doesn't look like a base58 Solana address", true);
    return;
  }

  btn.disabled = true;
  try {
    const breakdown = await computeRiskScore(net.rpc, address, (step) => setStatus(`${step} (${net.label})`));
    render(decisionForScore(breakdown.score), breakdown.score, breakdown.flags, breakdown.reasons);
    setStatus(`done - screened against live ${net.label} RPC just now`);
  } catch (err) {
    renderUnscored(err && err.message ? err.message : String(err));
    setStatus(`screening could not complete on ${net.label} - see UNSCORED result below, this is not a clean result`, true);
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  el("screenBtn").addEventListener("click", onScreen);
  el("address").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onScreen();
  });
});
