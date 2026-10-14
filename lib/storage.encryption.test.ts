import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { randomBytes } from "node:crypto"
import path from "node:path"

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

import { readFile, saveFile, saveFileAt, saveFileToManagedPath, storageEncryptionEnabled, storageName } from "./storage"
import { isEncryptedFile, StorageCryptoError } from "./storage-crypto"

const plain = Buffer.from("%PDF-1.7 synthetic bank statement for a test client")
const UPLOADS = path.join(process.cwd(), "uploads")

beforeEach(() => {
  disk.clear()
  vi.stubEnv("UPLOADS_ENC_KEY", randomBytes(32).toString("base64"))
  vi.stubEnv("UPLOADS_ENC_REQUIRED", "")
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

  it("encrypts managed-path and fixed-path (disclosure) writes too", async () => {
    const managed = await saveFileToManagedPath(plain, "application/pdf", "section129-abcdefghijklmnop")
    expect(isEncryptedFile(disk.get(managed.storagePath)!)).toBe(true)
    expect((await readFile(managed.storagePath)).equals(plain)).toBe(true)
    const at = await saveFileAt("disclosures/tenant-1/abc.pdf", plain)
    expect(at.storagePath).toBe(path.join(UPLOADS, "disclosures", "tenant-1", "abc.pdf"))
    expect(storageName(at.storagePath)).toBe("disclosures/tenant-1/abc.pdf")
    expect(isEncryptedFile(disk.get(at.storagePath)!)).toBe(true)
    expect((await readFile(at.storagePath)).equals(plain)).toBe(true)
  })

  it.each(["../x.pdf", "disclosures/../x.pdf", "x.pdf", "disclosures//x.pdf", "disclosures/t 1/x.pdf"])("refuses the fixed path %s", async (p) => {
    await expect(saveFileAt(p, plain)).rejects.toThrow(/Invalid storage path/)
  })

  it("refuses a tampered file instead of returning altered bytes", async () => {
    const { storagePath } = await saveFile(plain, "application/pdf")
    const bytes = Buffer.from(disk.get(storagePath)!)
    bytes[bytes.length - 2] ^= 0xff
    disk.set(storagePath, bytes)
    await expect(readFile(storagePath)).rejects.toThrow(StorageCryptoError)
  })

  it("refuses one client's file swapped in under another's name", async () => {
    const a = await saveFile(Buffer.from("%PDF synthetic client A"), "application/pdf")
    const b = await saveFile(Buffer.from("%PDF synthetic client B"), "application/pdf")
    disk.set(a.storagePath, disk.get(b.storagePath)!)
    await expect(readFile(a.storagePath)).rejects.toThrow(/another name/)
  })

  it("fails closed on a file that carries the marker but a malformed header", async () => {
    const { storagePath } = await saveFile(plain, "application/pdf")
    disk.set(storagePath, disk.get(storagePath)!.subarray(0, 30))
    await expect(readFile(storagePath)).rejects.toThrow(/malformed/)
    const versioned = Buffer.from(disk.get(storagePath)!)
    versioned[6] = 0x09
    disk.set(storagePath, versioned)
    await expect(readFile(storagePath)).rejects.toThrow(StorageCryptoError)
  })

  it("still reads a file written before encryption was switched on, unless encryption is required", async () => {
    disk.set("/legacy/plain.pdf", plain)
    expect((await readFile("/legacy/plain.pdf")).equals(plain)).toBe(true)
    vi.stubEnv("UPLOADS_ENC_REQUIRED", "true")
    await expect(readFile("/legacy/plain.pdf")).rejects.toThrow(/stored in plaintext/)
  })

  it("without a key: plaintext when not required, refused when required, and an encrypted file never reads", async () => {
    const { storagePath } = await saveFile(plain, "application/pdf")
    vi.stubEnv("UPLOADS_ENC_KEY", "")
    expect(storageEncryptionEnabled()).toBe(false)
    await expect(readFile(storagePath)).rejects.toThrow(/UPLOADS_ENC_KEY is not set/)
    const legacy = await saveFile(plain, "application/pdf")
    expect(disk.get(legacy.storagePath)!.equals(plain)).toBe(true)
    vi.stubEnv("UPLOADS_ENC_REQUIRED", "true")
    const before = disk.size
    await expect(saveFile(plain, "application/pdf")).rejects.toThrow(/refusing to write an upload in plaintext/)
    expect(disk.size).toBe(before)
  })

  it("requires encryption by default in production, not on a demo stack", async () => {
    vi.stubEnv("UPLOADS_ENC_KEY", "")
    vi.stubEnv("NODE_ENV", "production")
    await expect(saveFile(plain, "application/pdf")).rejects.toThrow(StorageCryptoError)
    vi.stubEnv("DEMO_MODE", "true")
    await expect(saveFile(plain, "application/pdf")).resolves.toMatchObject({ fileSize: plain.length })
  })
})
