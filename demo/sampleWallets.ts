import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * A small, fixed rotation of real devnet addresses used by `--demo` mode so
 * the walkthrough is repeatable. "Demo" refers only to using a preset list
 * instead of watching live traffic - every score shown is still computed by
 * the exact same offchain/scorer heuristics against real RPC data, nothing
 * here is a hardcoded verdict.
 */
export interface DemoWalletEntry {
  label: string;
  address: PublicKey;
}

export function buildDemoWalletSet(): DemoWalletEntry[] {
  return [
    { label: "fresh keypair (no history)", address: Keypair.generate().publicKey },
    { label: "SPL Token Program", address: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") },
    { label: "Associated Token Program", address: new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL") },
    { label: "Memo Program", address: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr") },
  ];
}
