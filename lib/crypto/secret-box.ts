import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SecretBoxError"
  }
}

/** GCM tag length in bytes, pinned on both sides: Node accepts shorter tags (4, 8, 12-15) and checks only their prefix. */
const TAG_BYTES = 16

/** Unambiguous versioned marker for a sealed value. Content-based heuristics
 * (e.g. "has 3 colon-separated segments") misclassify free-form plaintext
 * secrets that happen to contain colons — this prefix can't collide with a
 * legacy plaintext row because plaintext never gets to choose it. */
const SEALED_PREFIX = "enc:v1:"

/** True if `value` is a sealed secret produced by `sealSecret`. */
export function isSealed(value: string): boolean {
  return value.startsWith(SEALED_PREFIX)
}

function loadKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64")
  if (key.length !== 32) throw new SecretBoxError("encryption key must be 32 bytes (base64)")
  return key
}

/** AES-256-GCM. Output is `enc:v1:iv:tag:ciphertext`, each segment (after the
 * marker) base64. */
export function sealSecret(plaintext: string, keyB64: string): string {
  const key = loadKey(keyB64)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES })
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return SEALED_PREFIX + [iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":")
}

export function openSecret(sealed: string, keyB64: string): string {
  if (!sealed.startsWith(SEALED_PREFIX)) throw new SecretBoxError("not a sealed value")
  const key = loadKey(keyB64)
  const remainder = sealed.slice(SEALED_PREFIX.length)
  const parts = remainder.split(":")
  if (parts.length !== 3) throw new SecretBoxError("malformed sealed value")
  const [ivB64, tagB64, ctB64] = parts
  try {
    const tag = Buffer.from(tagB64, "base64")
    if (tag.length !== TAG_BYTES) throw new SecretBoxError("malformed authentication tag")
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"), { authTagLength: TAG_BYTES })
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64")), decipher.final()]).toString("utf8")
  } catch {
    throw new SecretBoxError("decryption failed (tampered ciphertext or wrong key)")
  }
}
