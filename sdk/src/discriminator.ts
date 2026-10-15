import { createHash } from "crypto";

/**
 * Anchor derives both account and event discriminators as the first 8 bytes
 * of sha256("<namespace>:<Name>"). We recompute it here instead of shipping
 * a generated IDL, so the SDK has no dependency on an IDL file matching the
 * exact Anchor version used to build the program.
 */
export function discriminator(namespace: "account" | "event", name: string): Buffer {
  const hash = createHash("sha256").update(`${namespace}:${name}`).digest();
  return hash.subarray(0, 8);
}

export function matchesDiscriminator(data: Buffer, namespace: "account" | "event", name: string): boolean {
  const expected = discriminator(namespace, name);
  return data.subarray(0, 8).equals(expected);
}
