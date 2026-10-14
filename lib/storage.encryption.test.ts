import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { randomBytes } from "node:crypto"

const disk = vi.hoisted(() => new Map<string, Buffer>())

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (p: string, data: Buffer) => { disk.set(p, Buffer.from(data)) }),
    readFile: vi.fn(async (p: string) => {
      const bytes = disk.get(p)
      if (!bytes) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      return bytes
    }),
    unlink: vi.fn(async (p: string) => { disk.delete(p) }),
  },
}))

import { readFile, saveFile, saveFileToManagedPath, storageEncryptionEnabled } from "./storage"
import { isEncryptedFile, StorageCryptoError } from "./storage-crypto"

const plain = Buffer.from("%PDF-1.7 synthetic bank statement for a test client")

beforeEach(() => {
  disk.clear()
  vi.stubEnv("UPLOADS_ENC_KEY", randomBytes(32).toString("base64"))
})
afterEach(() => vi.unstubAllEnvs())

describe("lib/storage encryption at rest", () => {
  it("writes ciphertext, reports the plaintext size, and reads the plaintext back", async () => {
    const { storagePath, fileSize } = await saveFile(plain, "application/pdf")
    const onDisk = disk.get(storagePath)!
    expect(isEncryptedFile(onDisk)).toBe(true)
    expect(onDisk.includes(Buffer.from("synthetic bank statement"))).toBe(false)
    expect(fileSize).toBe(plain.length)
    expect((await readFile(storagePath)).equals(plain)).toBe(true)
    expect(storageEncryptionEnabled()).toBe(true)
  })

  it("encrypts managed-path writes too", async () => {
    const { storagePath } = await saveFileToManagedPath(plain, "application/pdf", "section129-abcdefghijklmnop")
    expect(isEncryptedFile(disk.get(storagePath)!)).toBe(true)
    expect((await readFile(storagePath)).equals(plain)).toBe(true)
  })

  it("refuses a tampered file instead of returning altered bytes", async () => {
    const { storagePath } = await saveFile(plain, "application/pdf")
    const bytes = Buffer.from(disk.get(storagePath)!)
    bytes[bytes.length - 2] ^= 0xff
    disk.set(storagePath, bytes)
    await expect(readFile(storagePath)).rejects.toThrow(StorageCryptoError)
  })

  it("still reads a file written before encryption was switched on", async () => {
    disk.set("/legacy/plain.pdf", plain)
    expect((await readFile("/legacy/plain.pdf")).equals(plain)).toBe(true)
  })

  it("without a key writes plaintext, and refuses to read an encrypted file", async () => {
    const { storagePath } = await saveFile(plain, "application/pdf")
    vi.stubEnv("UPLOADS_ENC_KEY", "")
    expect(storageEncryptionEnabled()).toBe(false)
    await expect(readFile(storagePath)).rejects.toThrow(/UPLOADS_ENC_KEY is not set/)
    const legacy = await saveFile(plain, "application/pdf")
    expect(disk.get(legacy.storagePath)!.equals(plain)).toBe(true)
  })
})
