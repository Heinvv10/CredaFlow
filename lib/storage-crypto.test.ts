import { describe, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import {
  decryptFile,
  ENCRYPTED_HEADER_LEN,
  encryptFile,
  isEncryptedFile,
  parseMasterKey,
  StorageCryptoError,
  uploadsMasterKey,
} from "./storage-crypto"

const master = randomBytes(32)
// Synthetic content: a PDF header and an obviously fake ID-number-shaped string.
const plain = Buffer.from("%PDF-1.7 synthetic test document 0000000000000 not a real person")

function flip(buf: Buffer, at: number): Buffer {
  const copy = Buffer.from(buf)
  copy[at] ^= 0x01
  return copy
}

describe("storage envelope encryption", () => {
  it("round-trips the bytes, including an empty file", () => {
    expect(decryptFile(encryptFile(plain, master), master).equals(plain)).toBe(true)
    expect(decryptFile(encryptFile(Buffer.alloc(0), master), master).length).toBe(0)
  })

  it("leaves no plaintext on disk and uses a fresh data key and IV per file", () => {
    const a = encryptFile(plain, master)
    const b = encryptFile(plain, master)
    expect(a.includes(Buffer.from("synthetic test document"))).toBe(false)
    expect(a.equals(b)).toBe(false)
    expect(a.length).toBe(ENCRYPTED_HEADER_LEN + plain.length)
    expect(isEncryptedFile(a)).toBe(true)
    expect(isEncryptedFile(plain)).toBe(false)
  })

  it("detects tampering anywhere in the header or the ciphertext", () => {
    const sealed = encryptFile(plain, master)
    // version byte, every header field after the key id, and the ciphertext
    const offsets = [15, 15 + 12, 15 + 28, 15 + 60, 15 + 72, ENCRYPTED_HEADER_LEN, sealed.length - 1]
    for (const at of offsets) {
      const bad = flip(sealed, at)
      if (!isEncryptedFile(bad)) continue // the version byte: no longer recognised as sealed
      expect(() => decryptFile(bad, master), `offset ${at}`).toThrow(StorageCryptoError)
    }
    expect(() => decryptFile(flip(sealed, 6), master)).toThrow(StorageCryptoError)
  })

  it("refuses a truncated file and names a wrong key", () => {
    const sealed = encryptFile(plain, master)
    expect(() => decryptFile(sealed.subarray(0, sealed.length - 3), master)).toThrow(/integrity/)
    expect(() => decryptFile(sealed, randomBytes(32))).toThrow(/different UPLOADS_ENC_KEY/)
  })

  it("accepts only a 32-byte base64 master key", () => {
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow(StorageCryptoError)
    expect(parseMasterKey(master.toString("base64")).equals(master)).toBe(true)
    expect(uploadsMasterKey({} as unknown as NodeJS.ProcessEnv)).toBeNull()
    expect(uploadsMasterKey({ UPLOADS_ENC_KEY: " " } as unknown as NodeJS.ProcessEnv)).toBeNull()
  })
})
