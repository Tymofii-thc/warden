import { PublicKey } from "@solana/web3.js";

export function registryPda(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("registry")], programId);
}

export function attestationPda(programId: PublicKey, wallet: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("attestation"), wallet.toBuffer()],
    programId
  );
}
