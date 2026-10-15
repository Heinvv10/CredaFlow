import { afterEach, beforeEach, describe, expect, it } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { encryptUploads, verifyUploads } from "../encrypt-uploads"
import { decryptFile, encryptFile, isEncryptedFile } from "../../lib/storage-crypto"

const master = randomBytes(32)
let dir: string
const p = (...s: string[]) => path.join(dir, ...s)

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-encrypt-uploads-"))
  await fs.writeFile(p("a.pdf"), "%PDF synthetic a")
  await fs.writeFile(p("b.jpeg"), "synthetic jpeg bytes")
  await fs.writeFile(p("c.pdf"), encryptFile(Buffer.from("already sealed"), master, "c.pdf"))
  await fs.mkdir(p("disclosures", "tenant-1"), { recursive: true })
  await fs.writeFile(p("disclosures", "tenant-1", "d.pdf"), "%PDF synthetic disclosure")
  await fs.mkdir(p("tenant-logos", "tenant-1"), { recursive: true })
  await fs.writeFile(p("tenant-logos", "tenant-1", "logo.png"), "png")
  await fs.mkdir(p(".pre-restore-1"))
  await fs.writeFile(p(".pre-restore-1", "old.pdf"), "old")
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("scripts/encrypt-uploads", () => {
  it("dry run reports what it would do and changes nothing", async () => {
    const r = await encryptUploads(dir, master, true)
    expect(r.encrypted).toEqual(["a.pdf", "b.jpeg", "disclosures/tenant-1/d.pdf"])
    expect(r.alreadyEncrypted).toBe(1)
    expect(r.skippedEntries.sort()).toEqual([".pre-restore-1", "tenant-logos"])
    expect(await fs.readFile(p("a.pdf"), "utf8")).toBe("%PDF synthetic a")
  })

  it("encrypts top-level and disclosure files in place under their own names, keeps the mode, and is idempotent", async () => {
    await fs.chmod(p("a.pdf"), 0o640)
    const first = await encryptUploads(dir, master, false)
    expect(first.encrypted).toEqual(["a.pdf", "b.jpeg", "disclosures/tenant-1/d.pdf"])
    expect(first.failed).toEqual([])
    const a = await fs.readFile(p("a.pdf"))
    expect(isEncryptedFile(a)).toBe(true)
    expect(decryptFile(a, master, "a.pdf").toString()).toBe("%PDF synthetic a")
    const d = await fs.readFile(p("disclosures", "tenant-1", "d.pdf"))
    expect(decryptFile(d, master, "disclosures/tenant-1/d.pdf").toString()).toBe("%PDF synthetic disclosure")
    expect((await fs.stat(p("a.pdf"))).mode & 0o777).toBe(0o640)
    expect(await fs.readFile(p("tenant-logos", "tenant-1", "logo.png"), "utf8")).toBe("png")
    expect(await fs.readFile(p(".pre-restore-1", "old.pdf"), "utf8")).toBe("old")
    expect((await fs.readdir(dir)).filter((n) => n.startsWith(".") && n !== ".pre-restore-1")).toEqual([])

    const second = await encryptUploads(dir, master, false)
    expect(second.encrypted).toEqual([])
    expect(second.alreadyEncrypted).toBe(4)
    expect((await fs.readFile(p("a.pdf"))).equals(a)).toBe(true)
  })

  it("removes temp files a crashed run left, and only those", async () => {
    await fs.writeFile(p(".a.pdf.enc-0123456789abcdef"), "half written")
    await fs.writeFile(p(".keep-me"), "not ours")
    const r = await encryptUploads(dir, master, false)
    expect(r.staleTempsRemoved).toBe(1)
    const left = await fs.readdir(dir)
    expect(left).not.toContain(".a.pdf.enc-0123456789abcdef")
    expect(left).toContain(".keep-me")
  })

  it("encrypts a plaintext file that merely starts with the marker; never re-wraps another key's or a damaged envelope", async () => {
    const lookalike = Buffer.concat([Buffer.from([0x00, 0x43, 0x46, 0x45, 0x4e, 0x43, 0x07]), Buffer.from(" synthetic text")])
    await fs.writeFile(p("lookalike.bin"), lookalike)
    await fs.writeFile(p("other.pdf"), encryptFile(Buffer.from("x"), randomBytes(32), "other.pdf"))
    const damaged = encryptFile(Buffer.from("y"), master, "damaged.pdf")
    damaged[damaged.length - 1] ^= 1
    await fs.writeFile(p("damaged.pdf"), damaged)
    const r = await encryptUploads(dir, master, false)
    expect(r.encrypted).toContain("lookalike.bin")
    expect(decryptFile(await fs.readFile(p("lookalike.bin")), master, "lookalike.bin").equals(lookalike)).toBe(true)
    expect(r.failed.map((f) => f.file).sort()).toEqual(["damaged.pdf", "other.pdf"])
    expect((await fs.readFile(p("damaged.pdf"))).equals(damaged)).toBe(true)
  })

  it("--verify opens every encrypted file under its name, names a tampered or moved one, and changes nothing", async () => {
    expect(await verifyUploads(dir, master)).toEqual({ opened: 1, plaintext: 3, failed: [] })
    await encryptUploads(dir, master, false)
    expect(await verifyUploads(dir, master)).toEqual({ opened: 4, plaintext: 0, failed: [] })
    const bytes = await fs.readFile(p("b.jpeg"))
    bytes[bytes.length - 1] ^= 0xff
    await fs.writeFile(p("b.jpeg"), bytes)
    await fs.rename(p("a.pdf"), p("moved.pdf"))
    const v = await verifyUploads(dir, master)
    expect(v.failed.map((f) => f.file).sort()).toEqual(["b.jpeg", "moved.pdf"])
    expect((await verifyUploads(dir, randomBytes(32))).failed).toHaveLength(4)
    expect((await fs.readFile(p("b.jpeg"))).equals(bytes)).toBe(true)
  })
})
