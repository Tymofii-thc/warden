import { Connection, Logs, PublicKey } from "@solana/web3.js";
import { WARDEN_PROGRAM_ID } from "./constants";
import { matchesDiscriminator } from "./discriminator";
import { AttestationEvent } from "./types";

const PROGRAM_DATA_PREFIX = "Program data: ";

function decodeAttestationSubmitted(raw: Buffer): AttestationEvent | null {
  if (raw.length < 8 + 32 + 2 + 4 + 8) return null;
  if (!matchesDiscriminator(raw, "event", "AttestationSubmitted")) return null;

  let offset = 8;
  const wallet = new PublicKey(raw.subarray(offset, offset + 32));
  offset += 32;
  const riskScore = raw.readUInt16LE(offset);
  offset += 2;
  const flags = raw.readUInt32LE(offset);
  offset += 4;
  const slot = raw.readBigUInt64LE(offset);

  return { wallet: wallet.toBase58(), riskScore, flags, slot };
}

/**
 * Streams AttestationSubmitted events in real time by subscribing to the
 * program's transaction logs and decoding Anchor's `sol_log_data` output
 * directly (no IDL / event parser dependency, see discriminator.ts).
 */
export function subscribeToAttestations(
  connection: Connection,
  onEvent: (event: AttestationEvent, signature: string) => void,
  programId: PublicKey = WARDEN_PROGRAM_ID
): number {
  const listener = (logs: Logs) => {
    if (logs.err) return;
    for (const line of logs.logs) {
      if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
      const base64Payload = line.slice(PROGRAM_DATA_PREFIX.length).trim();
      let raw: Buffer;
      try {
        raw = Buffer.from(base64Payload, "base64");
      } catch {
        continue;
      }
      const event = decodeAttestationSubmitted(raw);
      if (event) onEvent(event, logs.signature);
    }
  };

  return connection.onLogs(programId, listener, "confirmed");
}
