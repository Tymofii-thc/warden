import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { attestationPda, registryPda } from "./pda";
import {
  encodeInitializeRegistryArgs,
  encodeRotateAuthorityArgs,
  encodeSubmitAttestationArgs,
} from "./decode";

/** Account ordering below must exactly match the #[derive(Accounts)] structs in lib.rs. */

export function buildInitializeRegistryIx(
  programId: PublicKey,
  payer: PublicKey,
  admin: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  const [registry] = registryPda(programId);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: registry, isSigner: false, isWritable: true },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeInitializeRegistryArgs(admin, authority),
  });
}

export function buildSubmitAttestationIx(
  programId: PublicKey,
  authority: PublicKey,
  wallet: PublicKey,
  riskScore: number,
  flags: number
): TransactionInstruction {
  const [registry] = registryPda(programId);
  const [attestation] = attestationPda(programId, wallet);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: registry, isSigner: false, isWritable: false },
      { pubkey: attestation, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: encodeSubmitAttestationArgs(wallet, riskScore, flags),
  });
}

export function buildRotateAuthorityIx(
  programId: PublicKey,
  admin: PublicKey,
  newAuthority: PublicKey
): TransactionInstruction {
  const [registry] = registryPda(programId);

  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: registry, isSigner: false, isWritable: true },
      { pubkey: admin, isSigner: true, isWritable: false },
    ],
    data: encodeRotateAuthorityArgs(newAuthority),
  });
}
