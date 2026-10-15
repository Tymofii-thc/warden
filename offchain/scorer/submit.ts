import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction, Transaction } from "@solana/web3.js";
import { WARDEN_PROGRAM_ID } from "../../sdk/src/constants";
import { registryPda } from "../../sdk/src/pda";
import { buildInitializeRegistryIx, buildSubmitAttestationIx } from "../../sdk/src/instructions";
import { decisionForScore, flagsToNames } from "../../sdk/src/decision";
import { computeRiskScore } from "./scoreEngine";

const DEVNET_URL = "https://api.devnet.solana.com";
const AUTHORITY_DIR = path.join(os.homedir(), ".warden");
const AUTHORITY_PATH = path.join(AUTHORITY_DIR, "authority.json");

function loadOrCreateAuthority(): Keypair {
  if (fs.existsSync(AUTHORITY_PATH)) {
    const raw = JSON.parse(fs.readFileSync(AUTHORITY_PATH, "utf8"));
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }

  const keypair = Keypair.generate();
  fs.mkdirSync(AUTHORITY_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTHORITY_PATH, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
  console.log(`generated new oracle authority keypair at ${AUTHORITY_PATH} (public key only, never logging the secret)`);
  console.log(`authority public key: ${keypair.publicKey.toBase58()}`);
  return keypair;
}

async function ensureRegistry(connection: Connection, authority: Keypair): Promise<void> {
  const [registryAddress] = registryPda(WARDEN_PROGRAM_ID);
  const existing = await connection.getAccountInfo(registryAddress);
  if (existing) return;

  console.log("registry not found on-chain yet, initializing (admin = authority for this demo)...");
  const ix = buildInitializeRegistryIx(WARDEN_PROGRAM_ID, authority.publicKey, authority.publicKey, authority.publicKey);
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
  console.log(`registry initialized: ${sig}`);
}

async function main() {
  const walletArg = process.argv[2];
  if (!walletArg) {
    console.error("usage: ts-node offchain/scorer/submit.ts <walletAddress>");
    process.exit(1);
  }

  let wallet: PublicKey;
  try {
    wallet = new PublicKey(walletArg);
  } catch {
    console.error(`"${walletArg}" is not a valid base58 Solana address`);
    process.exit(1);
  }

  const connection = new Connection(DEVNET_URL, "confirmed");
  const authority = loadOrCreateAuthority();

  console.log(`screening ${wallet.toBase58()} against devnet transaction history...`);
  const breakdown = await computeRiskScore(connection, wallet);

  console.log("--- heuristic breakdown ---");
  for (const reason of breakdown.reasons) console.log(`  - ${reason}`);
  if (breakdown.reasons.length === 0) console.log("  - no risk signals observed");
  console.log(`score: ${breakdown.score} / 1000`);
  console.log(`decision: ${decisionForScore(breakdown.score)}`);
  console.log(`flags: ${flagsToNames(breakdown.flags).join(", ") || "(none)"}`);

  await ensureRegistry(connection, authority);

  const ix = buildSubmitAttestationIx(WARDEN_PROGRAM_ID, authority.publicKey, wallet, breakdown.score, breakdown.flags);
  const tx = new Transaction().add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority]);
  console.log(`attestation submitted on-chain: ${sig}`);
}

main().catch((err) => {
  console.error("submit.ts failed:", err);
  process.exit(1);
});
