import { Connection, PublicKey } from "@solana/web3.js";

const SIGNATURE_PAGE_SIZE = 1000;
const MAX_SIGNATURES_SCANNED = 1000;
const ONE_DAY_SECONDS = 24 * 60 * 60;

export interface WalletAgeResult {
  ageDays: number | null; // null = could not be determined within the scan cap
  signaturesScanned: number;
  cappedOut: boolean;
}

/**
 * Walks a wallet's signature history backward (paginated via `before`) to
 * find the oldest signature we can see, capped at MAX_SIGNATURES_SCANNED so
 * a wallet with enormous history doesn't stall the scorer. `cappedOut: true`
 * means the real first transaction may be older than what we found.
 */
export async function getWalletAge(connection: Connection, wallet: PublicKey): Promise<WalletAgeResult> {
  let before: string | undefined;
  let scanned = 0;
  let oldestBlockTime: number | null = null;

  while (scanned < MAX_SIGNATURES_SCANNED) {
    const page = await connection.getSignaturesForAddress(wallet, {
      before,
      limit: SIGNATURE_PAGE_SIZE,
    });
    if (page.length === 0) break;

    scanned += page.length;
    const last = page[page.length - 1];
    if (last.blockTime) oldestBlockTime = last.blockTime;
    before = last.signature;

    if (page.length < SIGNATURE_PAGE_SIZE) {
      // Reached the true start of history within the cap.
      return { ageDays: oldestBlockTime ? daysSince(oldestBlockTime) : null, signaturesScanned: scanned, cappedOut: false };
    }
  }

  return {
    ageDays: oldestBlockTime ? daysSince(oldestBlockTime) : null,
    signaturesScanned: scanned,
    cappedOut: true,
  };
}

function daysSince(unixSeconds: number): number {
  return Math.floor((Date.now() / 1000 - unixSeconds) / ONE_DAY_SECONDS);
}

export interface VelocityResult {
  last24h: number;
  totalObserved: number;
  burstRatio: number; // last24h / totalObserved, higher = more suspicious concentration
}

/**
 * Flags abnormal recent bursts: a wallet whose activity is almost entirely
 * within the last 24h (high burstRatio) looks different from one with a
 * steady, older history.
 */
export async function getVelocity(connection: Connection, wallet: PublicKey): Promise<VelocityResult> {
  const page = await connection.getSignaturesForAddress(wallet, { limit: SIGNATURE_PAGE_SIZE });
  const nowSeconds = Date.now() / 1000;
  const last24h = page.filter((s) => s.blockTime && nowSeconds - s.blockTime < ONE_DAY_SECONDS).length;
  const totalObserved = page.length;
  const burstRatio = totalObserved > 0 ? last24h / totalObserved : 0;
  return { last24h, totalObserved, burstRatio };
}

export interface FanoutResult {
  uniqueCounterparties: number;
  transactionsSampled: number;
  fanoutRatio: number; // unique counterparties / transactions sampled
}

/**
 * Samples recent parsed transactions and measures how many distinct
 * counterparty accounts the wallet touches relative to transaction count.
 * A very high ratio (almost every tx touches a brand-new counterparty) is
 * a weak mixer-style signal; a very low ratio means repeat interactions
 * with the same small set of accounts.
 */
export async function getCounterpartyFanout(
  connection: Connection,
  wallet: PublicKey,
  sampleSize = 20
): Promise<FanoutResult> {
  const page = await connection.getSignaturesForAddress(wallet, { limit: sampleSize });
  const counterparties = new Set<string>();
  let sampled = 0;

  for (const sig of page) {
    const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    sampled += 1;
    for (const key of tx.transaction.message.accountKeys) {
      const address = key.pubkey.toBase58();
      if (address !== wallet.toBase58()) counterparties.add(address);
    }
  }

  return {
    uniqueCounterparties: counterparties.size,
    transactionsSampled: sampled,
    fanoutRatio: sampled > 0 ? counterparties.size / sampled : 0,
  };
}

export interface FlaggedProgramResult {
  matched: boolean;
  matchedProgramIds: string[];
  transactionsSampled: number;
}

/**
 * Checks recent transactions for any instruction whose program ID appears in
 * `flaggedProgramIds` (see sampleFlaggedPrograms.ts - illustrative demo data
 * only, not a real intelligence feed).
 */
export async function checkFlaggedProgramInteraction(
  connection: Connection,
  wallet: PublicKey,
  flaggedProgramIds: PublicKey[],
  sampleSize = 20
): Promise<FlaggedProgramResult> {
  const flaggedSet = new Set(flaggedProgramIds.map((p) => p.toBase58()));
  const page = await connection.getSignaturesForAddress(wallet, { limit: sampleSize });
  const matched = new Set<string>();
  let sampled = 0;

  for (const sig of page) {
    const tx = await connection.getParsedTransaction(sig.signature, { maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    sampled += 1;
    for (const ix of tx.transaction.message.instructions) {
      const programId = "programId" in ix ? ix.programId.toBase58() : undefined;
      if (programId && flaggedSet.has(programId)) matched.add(programId);
    }
  }

  return { matched: matched.size > 0, matchedProgramIds: [...matched], transactionsSampled: sampled };
}
