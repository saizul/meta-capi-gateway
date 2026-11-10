import { createHash } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const SHA256_HEX = /^[a-f0-9]{64}$/i;

/** True when the value already looks like a SHA-256 hex digest. */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Hash a normalized value. Values that are already SHA-256 hex digests are
 * passed through (lower-cased) so callers that pre-hash are not double hashed.
 */
export function hashNormalized(value: string): string {
  return isSha256Hex(value) ? value.toLowerCase() : sha256(value);
}
