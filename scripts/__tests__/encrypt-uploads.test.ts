import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { encryptUploads, verifyUploads } from "../encrypt-uploads"
import { decryptFile, encryptFile, isEncryptedFile } from "../../lib/storage-crypto"

const master = randomBytes(32)
let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-encrypt-uploads-"))
  await fs.writeFile(path.join(dir, "a.pdf"), "%PDF synthetic a")
  await fs.writeFile(path.join(dir, "b.jpeg"), "synthetic jpeg bytes")
  await fs.writeFile(path.join(dir, "c.pdf"), encryptFile(Buffer.from("already sealed"), master))
  await fs.mkdir(path.join(dir, "disclosures"))
  await fs.writeFile(path.join(dir, "disclosures", "d.pdf"), "other writer")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("scripts/encrypt-uploads", () => {
  it("dry run reports what it would do and changes nothing", async () => {
    const r = await encryptUploads(dir, master, true)
    expect(r.encrypted).toEqual(["a.pdf", "b.jpeg"])
    expect(r.alreadyEncrypted).toBe(1)
    expect(r.skippedEntries).toEqual(["disclosures"])
    expect(await fs.readFile(path.join(dir, "a.pdf"), "utf8")).toBe("%PDF synthetic a")
  })

  it("encrypts plaintext files in place, keeps their mode, and is idempotent", async () => {
    await fs.chmod(path.join(dir, "a.pdf"), 0o640)
    const first = await encryptUploads(dir, master, false)
    expect(first.encrypted).toEqual(["a.pdf", "b.jpeg"])
    expect(first.failed).toEqual([])
    const a = await fs.readFile(path.join(dir, "a.pdf"))
    expect(isEncryptedFile(a)).toBe(true)
    expect(decryptFile(a, master).toString()).toBe("%PDF synthetic a")
    expect((await fs.stat(path.join(dir, "a.pdf"))).mode & 0o777).toBe(0o640)
    expect(await fs.readFile(path.join(dir, "disclosures", "d.pdf"), "utf8")).toBe("other writer")
    expect((await fs.readdir(dir)).filter((n) => n.startsWith("."))).toEqual([])

    const second = await encryptUploads(dir, master, false)
    expect(second.encrypted).toEqual([])
    expect(second.alreadyEncrypted).toBe(3)
    expect((await fs.readFile(path.join(dir, "a.pdf"))).equals(a)).toBe(true)
  })

  it("--verify opens every encrypted file, names a tampered one, and changes nothing", async () => {
    expect(await verifyUploads(dir, master)).toEqual({ opened: 1, plaintext: 2, failed: [] })
    await encryptUploads(dir, master, false)
    expect(await verifyUploads(dir, master)).toEqual({ opened: 3, plaintext: 0, failed: [] })
    const bytes = await fs.readFile(path.join(dir, "b.jpeg"))
    bytes[bytes.length - 1] ^= 0xff
    await fs.writeFile(path.join(dir, "b.jpeg"), bytes)
    const v = await verifyUploads(dir, master)
    expect(v.failed.map((f) => f.file)).toEqual(["b.jpeg"])
    expect((await verifyUploads(dir, randomBytes(32))).failed).toHaveLength(3)
    expect((await fs.readFile(path.join(dir, "b.jpeg"))).equals(bytes)).toBe(true)
  })
})
