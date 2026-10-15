import { describe, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import {
  classifyFile,
  decryptFile,
  ENCRYPTED_HEADER_LEN,
  encryptFile,
  isEncryptedFile,
  parseMasterKey,
  StorageCryptoError,
  uploadsEncryptionRequired,
  uploadsMasterKey,
} from "./storage-crypto"

const master = randomBytes(32)
const NAME = "3e7c1bfd-adb3-44af-9eaf-c55def5e719f.pdf"
// Synthetic content: a PDF header and an obviously fake ID-number-shaped string.
const plain = Buffer.from("%PDF-1.7 synthetic test document 0000000000000 not a real person")
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv

function flip(buf: Buffer, at: number): Buffer {
  const copy = Buffer.from(buf)
  copy[at] ^= 0x01
  return copy
}

describe("storage envelope encryption", () => {
  it("round-trips the bytes, including an empty file", () => {
    expect(decryptFile(encryptFile(plain, master, NAME), master, NAME).equals(plain)).toBe(true)
    expect(decryptFile(encryptFile(Buffer.alloc(0), master, NAME), master, NAME).length).toBe(0)
  })

  it("leaves no plaintext on disk and uses a fresh data key and IV per file", () => {
    const a = encryptFile(plain, master, NAME)
    const b = encryptFile(plain, master, NAME)
    expect(a.includes(Buffer.from("synthetic test document"))).toBe(false)
    expect(a.equals(b)).toBe(false)
    expect(a.length).toBe(ENCRYPTED_HEADER_LEN + plain.length)
    expect(isEncryptedFile(a)).toBe(true)
    expect(isEncryptedFile(plain)).toBe(false)
  })

  it("detects tampering anywhere in the header or the ciphertext", () => {
    const sealed = encryptFile(plain, master, NAME)
    // version byte, every header field, and the ciphertext
    for (const at of [6, 15, 15 + 12, 15 + 28, 15 + 60, 15 + 72, ENCRYPTED_HEADER_LEN, sealed.length - 1]) {
      expect(() => decryptFile(flip(sealed, at), master, NAME), `offset ${at}`).toThrow(StorageCryptoError)
    }
  })

  it("binds the file to its name: another file's bytes under this name do not decrypt", () => {
    const other = encryptFile(Buffer.from("%PDF another client's synthetic statement"), master, "other.pdf")
    expect(() => decryptFile(other, master, NAME)).toThrow(/stored under another name/)
    expect(() => decryptFile(other, master, "disclosures/t2/other.pdf")).toThrow(StorageCryptoError)
  })

  it("refuses a truncated file and names a wrong key", () => {
    const sealed = encryptFile(plain, master, NAME)
    expect(() => decryptFile(sealed.subarray(0, sealed.length - 3), master, NAME)).toThrow(/integrity/)
    expect(() => decryptFile(sealed.subarray(0, 40), master, NAME)).toThrow(/malformed/)
    expect(() => decryptFile(sealed, randomBytes(32), NAME)).toThrow(/different UPLOADS_ENC_KEY/)
  })

  it("classifies files for the conversion script", () => {
    const sealed = encryptFile(plain, master, NAME)
    expect(classifyFile(sealed, master, NAME)).toBe("encrypted")
    expect(classifyFile(plain, master, NAME)).toBe("plaintext")
    // a plaintext that merely starts with the marker, without a well-formed header
    expect(classifyFile(Buffer.concat([sealed.subarray(0, 6), Buffer.from([0x09]), plain]), master, NAME)).toBe("plaintext")
    expect(classifyFile(Buffer.concat([sealed.subarray(0, 6), Buffer.from("short")]), master, NAME)).toBe("plaintext")
    expect(classifyFile(flip(sealed, sealed.length - 1), master, NAME)).toBe("tampered")
    expect(classifyFile(sealed, master, "renamed.pdf")).toBe("tampered")
    expect(classifyFile(encryptFile(plain, randomBytes(32), NAME), master, NAME)).toBe("other-key")
  })

  it("accepts only a 32-byte base64 master key", () => {
    expect(() => parseMasterKey(randomBytes(16).toString("base64"))).toThrow(StorageCryptoError)
    expect(parseMasterKey(master.toString("base64")).equals(master)).toBe(true)
    expect(uploadsMasterKey(env({}))).toBeNull()
    expect(uploadsMasterKey(env({ UPLOADS_ENC_KEY: " " }))).toBeNull()
  })

  // Review round 2: a default-on requirement broke the first deploy of every
  // existing stack. Off unless switched on explicitly (provision-lender.sh
  // does for new lenders).
  it("requires encryption only when UPLOADS_ENC_REQUIRED says so, in any environment", () => {
    expect(uploadsEncryptionRequired(env({ NODE_ENV: "production" }))).toBe(false)
    expect(uploadsEncryptionRequired(env({ NODE_ENV: "production", UPLOADS_ENC_REQUIRED: "" }))).toBe(false)
    expect(uploadsEncryptionRequired(env({ NODE_ENV: "production", UPLOADS_ENC_REQUIRED: "false" }))).toBe(false)
    expect(uploadsEncryptionRequired(env({ NODE_ENV: "production", UPLOADS_ENC_REQUIRED: "true" }))).toBe(true)
    expect(uploadsEncryptionRequired(env({ NODE_ENV: "test", UPLOADS_ENC_REQUIRED: "1" }))).toBe(true)
    expect(uploadsEncryptionRequired(env({ NODE_ENV: "production", DEMO_MODE: "true", UPLOADS_ENC_REQUIRED: "true" }))).toBe(true)
  })
})
