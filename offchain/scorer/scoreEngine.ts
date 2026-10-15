import { Connection, PublicKey } from "@solana/web3.js";
import { FLAGS, MAX_SCORE } from "../../sdk/src/decision";
import {
  checkFlaggedProgramInteraction,
  getCounterpartyFanout,
  getVelocity,
  getWalletAge,
} from "./heuristics";
import { SAMPLE_FLAGGED_PROGRAM_IDS } from "./sampleFlaggedPrograms";

export interface ScoreBreakdown {
  score: number;
  flags: number;
  reasons: string[];
}

/**
 * Weighted, fully documented scoring - deliberately simple rather than a
 * black box. Each heuristic can only push the score up (there is no
 * "trusted" allowlist here); a wallet with no signals at all stays low.
 *
 *   wallet age unknown (no reachable history)  -> LOW_HISTORY,   +250
 *   wallet age < 3 days                        -> NEW_WALLET,    +200
 *   wallet age 3-14 days                       -> (no flag),      +80
 *   last-24h burst ratio > 0.8 (n >= 5 txs)     -> HIGH_VELOCITY, +200
 *   counterparty fanout ratio > 0.9 (n >= 5)    -> MIXER_PATTERN, +180
 *   touches a sample flagged program            -> MIXER_PATTERN, +300
 *
 * SANCTIONED is never set by this engine: it is reserved for a real,
 * licensed sanctions feed (see sampleFlaggedPrograms.ts) that this
 * hackathon-grade implementation does not have. Final score is capped at
 * MAX_SCORE (1000).
 */
export async function computeRiskScore(connection: Connection, wallet: PublicKey): Promise<ScoreBreakdown> {
  let score = 0;
  let flags = 0;
  const reasons: string[] = [];

  const age = await getWalletAge(connection, wallet);
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
  }

  const velocity = await getVelocity(connection, wallet);
  if (velocity.burstRatio > 0.8 && velocity.totalObserved >= 5) {
    score += 200;
    flags |= FLAGS.HIGH_VELOCITY;
    reasons.push(`burst ratio ${velocity.burstRatio.toFixed(2)} over ${velocity.totalObserved} txs (HIGH_VELOCITY, +200)`);
  }

  const fanout = await getCounterpartyFanout(connection, wallet);
  if (fanout.fanoutRatio > 0.9 && fanout.transactionsSampled >= 5) {
    score += 180;
    flags |= FLAGS.MIXER_PATTERN;
    reasons.push(`counterparty fanout ${fanout.fanoutRatio.toFixed(2)} over ${fanout.transactionsSampled} txs (MIXER_PATTERN, +180)`);
  }

  const flaggedProgram = await checkFlaggedProgramInteraction(connection, wallet, SAMPLE_FLAGGED_PROGRAM_IDS);
  if (flaggedProgram.matched) {
    score += 300;
    flags |= FLAGS.MIXER_PATTERN;
    reasons.push(`touched sample flagged program(s) ${flaggedProgram.matchedProgramIds.join(", ")} (MIXER_PATTERN, +300)`);
  }

  return { score: Math.min(score, MAX_SCORE), flags, reasons };
}
