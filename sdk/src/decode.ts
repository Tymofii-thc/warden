import { PublicKey } from "@solana/web3.js";
import { matchesDiscriminator } from "./discriminator";
import { RegistryAccount, RiskAttestationAccount } from "./types";

// Hand-rolled decoders matching the exact Borsh field layout Anchor's
// #[account] macro produces for programs/warden/src/lib.rs. Both structs
// contain only fixed-width primitives (no Vec/String), so a plain
// fixed-offset read is sufficient and avoids depending on a generated IDL.

const ATTESTATION_LEN = 8 + 32 + 2 + 4 + 8 + 32 + 1;
const REGISTRY_LEN = 8 + 32 + 32 + 1;

export function decodeRiskAttestation(data: Buffer): RiskAttestationAccount {
  if (data.length < ATTESTATION_LEN) {
    throw new Error(`RiskAttestation account data too short: ${data.length} < ${ATTESTATION_LEN}`);
  }
  if (!matchesDiscriminator(data, "account", "RiskAttestation")) {
    throw new Error("account discriminator does not match RiskAttestation");
  }

  let offset = 8;
  const wallet = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const riskScore = data.readUInt16LE(offset);
  offset += 2;
  const flags = data.readUInt32LE(offset);
  offset += 4;
  const lastUpdatedSlot = data.readBigUInt64LE(offset);
  offset += 8;
  const updatedBy = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const bump = data.readUInt8(offset);

  return {
    wallet: wallet.toBase58(),
    riskScore,
    flags,
    lastUpdatedSlot,
    updatedBy: updatedBy.toBase58(),
    bump,
  };
}

export function decodeRegistry(data: Buffer): RegistryAccount {
  if (data.length < REGISTRY_LEN) {
    throw new Error(`Registry account data too short: ${data.length} < ${REGISTRY_LEN}`);
  }
  if (!matchesDiscriminator(data, "account", "Registry")) {
    throw new Error("account discriminator does not match Registry");
  }

  let offset = 8;
  const admin = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const authority = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const bump = data.readUInt8(offset);

  return { admin: admin.toBase58(), authority: authority.toBase58(), bump };
}

/**
 * Builds the instruction data buffer for `submit_attestation(wallet, risk_score, flags)`.
 * Anchor instruction discriminators are the first 8 bytes of
 * sha256("global:<snake_case_instruction_name>").
 */
export function encodeSubmitAttestationArgs(wallet: PublicKey, riskScore: number, flags: number): Buffer {
  const { createHash } = require("crypto");
  const discHash: Buffer = createHash("sha256").update("global:submit_attestation").digest();
  const disc = discHash.subarray(0, 8);

  const buf = Buffer.alloc(8 + 32 + 2 + 4);
  disc.copy(buf, 0);
  wallet.toBuffer().copy(buf, 8);
  buf.writeUInt16LE(riskScore, 40);
  buf.writeUInt32LE(flags, 42);
  return buf;
}

export function encodeInitializeRegistryArgs(admin: PublicKey, authority: PublicKey): Buffer {
  const { createHash } = require("crypto");
  const discHash: Buffer = createHash("sha256").update("global:initialize_registry").digest();
  const disc = discHash.subarray(0, 8);

  const buf = Buffer.alloc(8 + 32 + 32);
  disc.copy(buf, 0);
  admin.toBuffer().copy(buf, 8);
  authority.toBuffer().copy(buf, 40);
  return buf;
}

export function encodeRotateAuthorityArgs(newAuthority: PublicKey): Buffer {
  const { createHash } = require("crypto");
  const discHash: Buffer = createHash("sha256").update("global:rotate_authority").digest();
  const disc = discHash.subarray(0, 8);

  const buf = Buffer.alloc(8 + 32);
  disc.copy(buf, 0);
  newAuthority.toBuffer().copy(buf, 8);
  return buf;
}
