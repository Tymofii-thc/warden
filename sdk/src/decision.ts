import { Decision } from "./types";

// Mirrors programs/warden/src/lib.rs. Keep both in sync if either changes -
// the on-chain program stores the raw score/flags, this file is the single
// source of truth for turning them into an ALLOW/REVIEW/BLOCK decision.
export const ALLOW_MAX = 300;
export const BLOCK_MIN = 700;
export const MAX_SCORE = 1000;

export const FLAGS: Record<string, number> = {
  SANCTIONED: 1 << 0,
  MIXER_PATTERN: 1 << 1,
  NEW_WALLET: 1 << 2,
  HIGH_VELOCITY: 1 << 3,
  LOW_HISTORY: 1 << 4,
};

export function decisionForScore(score: number): Decision {
  if (score < ALLOW_MAX) return "ALLOW";
  if (score < BLOCK_MIN) return "REVIEW";
  return "BLOCK";
}

export function flagsToNames(flags: number): string[] {
  return Object.entries(FLAGS)
    .filter(([, bit]) => (flags & bit) !== 0)
    .map(([name]) => name);
}

export function namesToFlags(names: string[]): number {
  return names.reduce((acc, name) => acc | (FLAGS[name] ?? 0), 0);
}
