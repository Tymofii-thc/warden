import { Connection, PublicKey } from "@solana/web3.js";
import { buildUi, decisionColor } from "./ui";
import { buildDemoWalletSet, DemoWalletEntry } from "./sampleWallets";
import { computeRiskScore } from "../offchain/scorer/scoreEngine";
import { decisionForScore, flagsToNames } from "../sdk/src/decision";

const DEVNET_URL = "https://api.devnet.solana.com";
const TICK_MS = 100; // 10fps
const DEMO_STEP_MS = 4000;
const LIVE_STEP_MS = 4000; // throttle: process at most one discovered wallet every 4s
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const isDemo = process.argv.includes("--demo");

async function main() {
  const connection = new Connection(DEVNET_URL, "confirmed");
  const ui = buildUi();

  const tally: Record<string, number> = { ALLOW: 0, REVIEW: 0, BLOCK: 0, UNSCORED: 0 };
  let spinnerIndex = 0;
  let screened = 0;
  const startedAt = Date.now();

  ui.feedBox.log(isDemo
    ? "{grey-fg}mode: --demo (preset real devnet addresses, rotated every 4s){/grey-fg}"
    : "{grey-fg}mode: live (subscribed to devnet transaction logs){/grey-fg}");

  function renderTally() {
    const parts = [
      `{green-fg}ALLOW ${tally.ALLOW}{/green-fg}`,
      `{yellow-fg}REVIEW ${tally.REVIEW}{/yellow-fg}`,
      `{red-fg}BLOCK ${tally.BLOCK}{/red-fg}`,
      `{grey-fg}UNSCORED ${tally.UNSCORED}{/grey-fg}`,
      `  total screened: ${screened}`,
    ];
    ui.tallyBox.setContent(parts.join("   "));
  }

  function renderFooter(status: string) {
    const frame = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
    const uptimeSec = Math.floor((Date.now() - startedAt) / 1000);
    ui.footerBox.setContent(
      ` ${frame} devnet (${DEVNET_URL})  |  uptime ${uptimeSec}s  |  ${status}  |  q to quit`
    );
  }

  async function screenAndRender(label: string, address: PublicKey) {
    ui.feedBox.log(`{cyan-fg}>{/cyan-fg} screening ${label} {grey-fg}${address.toBase58()}{/grey-fg}`);
    try {
      const breakdown = await computeRiskScore(connection, address);
      const decision = decisionForScore(breakdown.score);
      const color = decisionColor(decision);
      const flagNames = flagsToNames(breakdown.flags);

      tally[decision] = (tally[decision] ?? 0) + 1;
      screened += 1;

      ui.decisionBox.log(
        `{${color}-fg}{bold}[${decision}]{/bold}{/${color}-fg} score=${breakdown.score} ` +
          `flags=${flagNames.join(",") || "none"} ${address.toBase58().slice(0, 8)}...`
      );
      for (const reason of breakdown.reasons) {
        ui.decisionBox.log(`    {grey-fg}- ${reason}{/grey-fg}`);
      }
      renderTally();
    } catch (err: any) {
      ui.decisionBox.log(`{red-fg}error screening ${label}: ${err?.message ?? err}{/red-fg}`);
    }
  }

  // --- data source ---
  if (isDemo) {
    const wallets = buildDemoWalletSet();
    let i = 0;
    const stepDemo = async () => {
      const entry: DemoWalletEntry = wallets[i % wallets.length];
      i += 1;
      await screenAndRender(entry.label, entry.address);
    };
    void stepDemo();
    setInterval(() => void stepDemo(), DEMO_STEP_MS);
  } else {
    const queue: string[] = [];
    const seen = new Set<string>();

    connection.onLogs(
      "all",
      (logs) => {
        if (logs.err) return;
        // We don't have the account list from onLogs("all") directly, so we
        // surface the signature and resolve the fee payer lazily in the
        // consumer below via getParsedTransaction - this keeps the log
        // subscription itself cheap.
        queue.push(logs.signature);
      },
      "confirmed"
    );

    const consumeOne = async () => {
      const signature = queue.shift();
      if (!signature) {
        renderFooter("waiting for devnet traffic...");
        return;
      }
      if (seen.has(signature)) return;
      seen.add(signature);

      const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
      const feePayer = tx?.transaction.message.accountKeys[0]?.pubkey;
      if (!feePayer) return;

      await screenAndRender("live devnet wallet", feePayer);
    };

    setInterval(() => void consumeOne(), LIVE_STEP_MS);
  }

  // --- animation ticker ---
  setInterval(() => {
    spinnerIndex += 1;
    renderFooter(isDemo ? "cycling demo wallet set" : "watching live devnet logs");
    ui.screen.render();
  }, TICK_MS);

  renderTally();
  renderFooter("starting...");
  ui.screen.render();
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
