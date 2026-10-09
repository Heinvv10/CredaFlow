import { createHash } from "node:crypto"

const SHA256_PATTERN = /^[0-9a-f]{64}$/

export function sha256DocumentBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value)
}

export function documentBytesMatchSha256(
  bytes: Uint8Array,
  expectedSha256: unknown,
): boolean {
  return isSha256Digest(expectedSha256) &&
    sha256DocumentBytes(bytes) === expectedSha256
}
