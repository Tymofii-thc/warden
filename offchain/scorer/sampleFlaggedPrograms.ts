import { PublicKey } from "@solana/web3.js";

/**
 * ============================================================================
 * ILLUSTRATIVE PLACEHOLDER DATA - NOT A REAL THREAT INTELLIGENCE FEED
 * ============================================================================
 * These are freshly generated, never-deployed keypairs used only so the demo
 * has *something* concrete to flag. A real deployment must replace this list
 * with a licensed, maintained sanctions/risk feed (e.g. a real OFAC SDN
 * crypto-address list, or a commercial provider such as Chainalysis/TRM).
 * Treat any "match" against this list as a demo artifact, never as evidence
 * of real-world sanctioned or malicious activity.
 * ============================================================================
 */
export const SAMPLE_FLAGGED_PROGRAM_IDS: PublicKey[] = [
  new PublicKey("G5DN8xLS4RPC2kxE3EAqyyVpKQWd4McPsQFZqi1Bc7Eb"),
  new PublicKey("HXea3GMpPAwktF95WqheK44CTZNsodbwT4xDp7RKYCvs"),
  new PublicKey("JEGvZL3Bnbs62fnj8BPhahdTUCT5yCFLjyg6Brkm9Wqd"),
];
