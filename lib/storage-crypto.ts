import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

/**
 * Envelope encryption for files at rest (lib/storage.ts).
 *
 * Each file gets its own random 256-bit data key (DEK). The file is encrypted
 * with the DEK (AES-256-GCM); the DEK is wrapped with the master key from
 * UPLOADS_ENC_KEY (AES-256-GCM, 32 bytes, base64) and stored in the header.
 *
 *   magic "\0CFENC" | version 0x01 | keyId (8) | wrapIv (12) | wrapTag (16)
 *   | wrappedDek (32) | dataIv (12) | dataTag (16) | ciphertext
 *
 * keyId is the first 8 bytes of SHA-256(master key), so a file sealed under a
 * different key fails with a clear error instead of a generic tag mismatch.
 * Both GCM operations authenticate the header bytes before them as AAD: any
 * change to the header or the ciphertext fails decryption.
 *
 * lib/crypto/secret-box.ts is not reused: it seals UTF-8 strings into a text
 * format with one key and no envelope.
 */

export class StorageCryptoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StorageCryptoError"
  }
}

const MAGIC = Buffer.from([0x00, 0x43, 0x46, 0x45, 0x4e, 0x43]) // "\0CFENC"
const VERSION = 0x01
const KEY_ID_LEN = 8
const IV_LEN = 12
const TAG_LEN = 16
const DEK_LEN = 32
const WRAP_AAD_LEN = MAGIC.length + 1 + KEY_ID_LEN
const WRAPPED_END = WRAP_AAD_LEN + IV_LEN + TAG_LEN + DEK_LEN
export const ENCRYPTED_HEADER_LEN = WRAPPED_END + IV_LEN + TAG_LEN

export function parseMasterKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, "base64")
  if (key.length !== 32) throw new StorageCryptoError("UPLOADS_ENC_KEY must be 32 bytes, base64-encoded")
  return key
}

/** The configured master key, or null when encryption at rest is off. */
export function uploadsMasterKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = env.UPLOADS_ENC_KEY?.trim()
  return raw ? parseMasterKey(raw) : null
}

function keyId(master: Buffer): Buffer {
  return createHash("sha256").update(master).digest().subarray(0, KEY_ID_LEN)
}

export function isEncryptedFile(bytes: Buffer): boolean {
  return bytes.length >= ENCRYPTED_HEADER_LEN
    && bytes.subarray(0, MAGIC.length).equals(MAGIC)
    && bytes[MAGIC.length] === VERSION
}

export function encryptFile(plaintext: Buffer, master: Buffer): Buffer {
  const dek = randomBytes(DEK_LEN)
  const prefix = Buffer.concat([MAGIC, Buffer.from([VERSION]), keyId(master)])

  const wrapIv = randomBytes(IV_LEN)
  const wrap = createCipheriv("aes-256-gcm", master, wrapIv)
  wrap.setAAD(prefix)
  const wrappedDek = Buffer.concat([wrap.update(dek), wrap.final()])
  const wrapTag = wrap.getAuthTag()

  const dataIv = randomBytes(IV_LEN)
  const header = Buffer.concat([prefix, wrapIv, wrapTag, wrappedDek])
  const cipher = createCipheriv("aes-256-gcm", dek, dataIv)
  cipher.setAAD(Buffer.concat([header, dataIv]))
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([header, dataIv, cipher.getAuthTag(), ciphertext])
}

export function decryptFile(sealed: Buffer, master: Buffer): Buffer {
  if (!isEncryptedFile(sealed)) throw new StorageCryptoError("not an encrypted file")
  const prefix = sealed.subarray(0, WRAP_AAD_LEN)
  if (!prefix.subarray(MAGIC.length + 1).equals(keyId(master))) {
    throw new StorageCryptoError("file was encrypted with a different UPLOADS_ENC_KEY")
  }
  let o = WRAP_AAD_LEN
  const wrapIv = sealed.subarray(o, (o += IV_LEN))
  const wrapTag = sealed.subarray(o, (o += TAG_LEN))
  const wrappedDek = sealed.subarray(o, (o += DEK_LEN))
  const dataIv = sealed.subarray(o, (o += IV_LEN))
  const dataTag = sealed.subarray(o, (o += TAG_LEN))
  try {
    const unwrap = createDecipheriv("aes-256-gcm", master, wrapIv)
    unwrap.setAAD(prefix)
    unwrap.setAuthTag(wrapTag)
    const dek = Buffer.concat([unwrap.update(wrappedDek), unwrap.final()])

    const decipher = createDecipheriv("aes-256-gcm", dek, dataIv)
    decipher.setAAD(sealed.subarray(0, WRAPPED_END + IV_LEN))
    decipher.setAuthTag(dataTag)
    return Buffer.concat([decipher.update(sealed.subarray(ENCRYPTED_HEADER_LEN)), decipher.final()])
  } catch {
    throw new StorageCryptoError("encrypted file failed its integrity check (tampered or corrupt)")
  }
}
