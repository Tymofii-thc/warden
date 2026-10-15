import { Connection, PublicKey } from "@solana/web3.js";
import { WARDEN_PROGRAM_ID } from "./constants";
import { decodeRiskAttestation } from "./decode";
import { attestationPda } from "./pda";
import { decisionForScore, flagsToNames } from "./decision";
import { ScreeningResult } from "./types";

/**
 * Looks up a wallet's on-chain risk attestation. If none has ever been
 * submitted, `attested` is false and `decision` is "UNSCORED" - callers must
 * treat an unscored wallet as unknown, never as implicitly safe.
 */
export async function screenWallet(
  connection: Connection,
  wallet: PublicKey,
  programId: PublicKey = WARDEN_PROGRAM_ID
): Promise<ScreeningResult> {
  const [attestationAddress] = attestationPda(programId, wallet);
  const accountInfo = await connection.getAccountInfo(attestationAddress);

  if (!accountInfo) {
    return {
      wallet: wallet.toBase58(),
      attested: false,
      score: null,
      decision: "UNSCORED",
      flags: [],
      lastUpdatedSlot: null,
    };
  }

  const decoded = decodeRiskAttestation(accountInfo.data);
  return {
    wallet: decoded.wallet,
    attested: true,
    score: decoded.riskScore,
    decision: decisionForScore(decoded.riskScore),
    flags: flagsToNames(decoded.flags),
    lastUpdatedSlot: decoded.lastUpdatedSlot,
  };
}
