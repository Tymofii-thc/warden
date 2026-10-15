import { ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { expect } from "chai";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { WARDEN_PROGRAM_ID } from "../sdk/src/constants";
import { registryPda, attestationPda } from "../sdk/src/pda";
import {
  buildInitializeRegistryIx,
  buildRotateAuthorityIx,
  buildSubmitAttestationIx,
} from "../sdk/src/instructions";
import { decodeRegistry, decodeRiskAttestation } from "../sdk/src/decode";
import { decisionForScore, ALLOW_MAX, BLOCK_MIN } from "../sdk/src/decision";

/**
 * This suite runs against a throwaway `solana-test-validator` instance that
 * it spawns and deploys programs/warden/target/deploy/warden.so into. It is
 * a drop-in replacement for `anchor test` - we don't have the `anchor` CLI
 * installed in this environment, but we do have the Solana CLI toolchain
 * (solana-test-validator, solana program deploy), so the suite is fully
 * runnable: `npm test` (see package.json).
 *
 * The Registry PDA is a global singleton (seeds = ["registry"]), so unlike
 * a typical per-test fixture it can only be created once for the whole
 * validator instance. Tests therefore run in a deliberate sequence, sharing
 * `sharedAdmin` (the registry's admin) and threading the "current
 * authority" keypair from one test to the next via rotate_authority,
 * instead of each test trying to re-initialize its own registry.
 */

const RPC_URL = "http://127.0.0.1:8899";
const LEDGER_DIR = path.join(os.tmpdir(), `warden-test-ledger-${Date.now()}`);
const PROGRAM_SO = path.join(__dirname, "..", "target", "deploy", "warden.so");

let validator: ChildProcess | null = null;
let connection: Connection;
let sharedAdmin: Keypair;
let currentAuthority: Keypair;

async function waitForValidator(conn: Connection, timeoutMs = 30000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await conn.getVersion();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error("solana-test-validator did not become healthy in time");
}

async function airdrop(conn: Connection, pubkey: PublicKey, sol = 2): Promise<void> {
  const sig = await conn.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}

async function expectRejected(promise: Promise<unknown>, context: string): Promise<void> {
  let threw = false;
  try {
    await promise;
  } catch {
    threw = true;
  }
  expect(threw, context).to.equal(true);
}

describe("warden", function () {
  this.timeout(120000);

  before(async function () {
    if (!fs.existsSync(PROGRAM_SO)) {
      throw new Error(`${PROGRAM_SO} not found - run \`npm run build:program\` first`);
    }

    fs.mkdirSync(LEDGER_DIR, { recursive: true });
    validator = spawn(
      "solana-test-validator",
      [
        "--ledger", LEDGER_DIR,
        "--bpf-program", WARDEN_PROGRAM_ID.toBase58(), PROGRAM_SO,
        "--reset",
        "--quiet",
      ],
      { stdio: "ignore" }
    );

    connection = new Connection(RPC_URL, "confirmed");
    await waitForValidator(connection);

    sharedAdmin = Keypair.generate();
    await airdrop(connection, sharedAdmin.publicKey);
  });

  after(function () {
    validator?.kill();
    fs.rmSync(LEDGER_DIR, { recursive: true, force: true });
  });

  it("initializes the registry with admin == authority", async () => {
    const ix = buildInitializeRegistryIx(WARDEN_PROGRAM_ID, sharedAdmin.publicKey, sharedAdmin.publicKey, sharedAdmin.publicKey);
    await sendAndConfirmTransaction(connection, new Transaction().add(ix), [sharedAdmin]);

    const [registryAddress] = registryPda(WARDEN_PROGRAM_ID);
    const info = await connection.getAccountInfo(registryAddress);
    expect(info).to.not.be.null;

    const registry = decodeRegistry(info!.data);
    expect(registry.admin).to.equal(sharedAdmin.publicKey.toBase58());
    expect(registry.authority).to.equal(sharedAdmin.publicKey.toBase58());

    currentAuthority = sharedAdmin;
  });

  it("lets the admin hand scoring authority to a dedicated keypair via rotate_authority", async () => {
    const authority = Keypair.generate();
    await airdrop(connection, authority.publicKey);

    const rotateIx = buildRotateAuthorityIx(WARDEN_PROGRAM_ID, sharedAdmin.publicKey, authority.publicKey);
    await sendAndConfirmTransaction(connection, new Transaction().add(rotateIx), [sharedAdmin]);

    const [registryAddress] = registryPda(WARDEN_PROGRAM_ID);
    const info = await connection.getAccountInfo(registryAddress);
    expect(decodeRegistry(info!.data).authority).to.equal(authority.publicKey.toBase58());

    currentAuthority = authority;
  });

  it("lets the current authority submit an attestation, and rejects a non-authority signer", async () => {
    const impostor = Keypair.generate();
    const targetWallet = Keypair.generate().publicKey;
    await airdrop(connection, impostor.publicKey);

    const goodIx = buildSubmitAttestationIx(WARDEN_PROGRAM_ID, currentAuthority.publicKey, targetWallet, 150, 0);
    await sendAndConfirmTransaction(connection, new Transaction().add(goodIx), [currentAuthority]);

    const [attestationAddress] = attestationPda(WARDEN_PROGRAM_ID, targetWallet);
    const info = await connection.getAccountInfo(attestationAddress);
    const attestation = decodeRiskAttestation(info!.data);
    expect(attestation.riskScore).to.equal(150);
    expect(decisionForScore(attestation.riskScore)).to.equal("ALLOW");

    const otherWallet = Keypair.generate().publicKey;
    const badIx = buildSubmitAttestationIx(WARDEN_PROGRAM_ID, impostor.publicKey, otherWallet, 999, 0);
    await expectRejected(
      sendAndConfirmTransaction(connection, new Transaction().add(badIx), [impostor]),
      "submit_attestation from a non-authority signer should fail"
    );
  });

  it("rejects a risk_score above 1000", async () => {
    const targetWallet = Keypair.generate().publicKey;
    const ix = buildSubmitAttestationIx(WARDEN_PROGRAM_ID, currentAuthority.publicKey, targetWallet, 1001, 0);
    await expectRejected(
      sendAndConfirmTransaction(connection, new Transaction().add(ix), [currentAuthority]),
      "risk_score > 1000 should be rejected on-chain"
    );
  });

  it("lets the admin rotate the authority again, and the old authority loses write access", async () => {
    const oldAuthority = currentAuthority;
    const newAuthority = Keypair.generate();
    const targetWallet = Keypair.generate().publicKey;
    await airdrop(connection, newAuthority.publicKey);

    const rotateIx = buildRotateAuthorityIx(WARDEN_PROGRAM_ID, sharedAdmin.publicKey, newAuthority.publicKey);
    await sendAndConfirmTransaction(connection, new Transaction().add(rotateIx), [sharedAdmin]);

    const [registryAddress] = registryPda(WARDEN_PROGRAM_ID);
    const info = await connection.getAccountInfo(registryAddress);
    expect(decodeRegistry(info!.data).authority).to.equal(newAuthority.publicKey.toBase58());

    const staleIx = buildSubmitAttestationIx(WARDEN_PROGRAM_ID, oldAuthority.publicKey, targetWallet, 10, 0);
    await expectRejected(
      sendAndConfirmTransaction(connection, new Transaction().add(staleIx), [oldAuthority]),
      "old authority should lose write access after rotation"
    );

    currentAuthority = newAuthority;
  });

  it("SDK decision thresholds match the documented boundaries (ALLOW < 300, BLOCK >= 700)", () => {
    expect(decisionForScore(0)).to.equal("ALLOW");
    expect(decisionForScore(ALLOW_MAX - 1)).to.equal("ALLOW");
    expect(decisionForScore(ALLOW_MAX)).to.equal("REVIEW");
    expect(decisionForScore(BLOCK_MIN - 1)).to.equal("REVIEW");
    expect(decisionForScore(BLOCK_MIN)).to.equal("BLOCK");
    expect(decisionForScore(1000)).to.equal("BLOCK");
  });
});
