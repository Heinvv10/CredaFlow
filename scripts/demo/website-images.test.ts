import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeJpeg } from "../../lib/config/__fixtures__/images"
import { makePng } from "../../lib/config/__fixtures__/png"
import type { ImageryWriteDb } from "../../lib/config/website-imagery"
import { applyImageDir, loadImageDir } from "./website-images"

let dir = ""
let root = ""
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "imagery-dir-"))
  root = mkdtempSync(path.join(tmpdir(), "imagery-root-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(root, { recursive: true, force: true })
})

const manifest = (value: unknown) => writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(value))
const file = (name: string, bytes: Uint8Array) => writeFileSync(path.join(dir, name), bytes)

function validDir() {
  file("hero.jpg", makeJpeg(1600, 900))
  file("product-personal.png", makePng(640, 360))
  file("community.jpeg", makeJpeg(900, 600))
  manifest({
    hero: { alt: "A hero" },
    "product-personal": { alt: "A card" },
    community: { alt: "A street", heading: "Our street", body: "We live here." },
  })
}

describe("loadImageDir", () => {
  it("pairs each slot's file with its manifest entry, in slot order, whatever the extension", () => {
    validDir()
    const { entries, errors } = loadImageDir(dir)
    expect(errors).toEqual([])
    expect(entries.map((e) => [e.slot, e.file, e.text.alt])).toEqual([
      ["hero", "hero.jpg", "A hero"],
      ["product-personal", "product-personal.png", "A card"],
      ["community", "community.jpeg", "A street"],
    ])
  })

  it("names every problem: a missing manifest, a file with no entry, an entry with no file, an unknown slot, missing alt text", () => {
    expect(loadImageDir(dir).errors).toEqual([expect.stringContaining("manifest.json is missing")])
    file("hero.jpg", makeJpeg(10, 10))
    file("banner.jpg", makeJpeg(10, 10))
    manifest({ "product-personal": { alt: "A card" }, mortgage: { alt: "x" } })
    const { entries, errors } = loadImageDir(dir)
    expect(entries).toEqual([])
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("banner.jpg: not a slot"),
      expect.stringContaining("manifest.json: product-personal has no image file"),
      expect.stringContaining("manifest.json: mortgage is not a slot"),
      expect.stringContaining("hero.jpg: no manifest.json entry for hero"),
    ]))
    manifest({ hero: {} })
    expect(loadImageDir(dir).errors[0]).toMatch(/alt/)
  })

  it("refuses two files for one slot and an unreadable manifest", () => {
    file("hero.jpg", makeJpeg(10, 10))
    file("hero.png", makePng(10, 10))
    manifest({ hero: { alt: "x" } })
    expect(loadImageDir(dir).errors).toEqual([expect.stringContaining("a second file for hero")])
    writeFileSync(path.join(dir, "manifest.json"), "{ not json")
    expect(loadImageDir(dir).errors).toEqual([expect.stringContaining("is not JSON")])
  })
})

type Doc = Record<string, unknown>
function memoryDb() {
  const state = { doc: null as unknown, audit: [] as Array<{ action: string; userId: string | null; userEmail: string | null }> }
  const tx = {
    $executeRaw: async () => 0,
    tenantConfig: {
      findUnique: async () => ({ websiteImagery: state.doc }),
      upsert: async ({ update }: { update: { websiteImagery: Doc } }) => { state.doc = update.websiteImagery; return {} },
    },
    auditLog: { create: async ({ data }: { data: { action: string; userId: string | null; userEmail: string | null } }) => { state.audit.push(data); return data } },
  }
  return { db: { $transaction: async (fn: (t: never) => Promise<unknown>) => fn(tx as never) } as unknown as ImageryWriteDb, state }
}

describe("applyImageDir", () => {
  it("writes every slot through the product's write path, audited as the system actor, and is idempotent", async () => {
    validDir()
    const { entries } = loadImageDir(dir)
    const { db, state } = memoryDb()
    expect(await applyImageDir(db, { tenantId: "tenant-1", entries, root })).toEqual({ ok: true, written: ["hero", "product-personal", "community"], unchanged: [] })
    expect(Object.keys(state.doc as Doc).sort()).toEqual(["community", "hero", "products"])
    expect(state.audit).toHaveLength(3)
    expect(state.audit[0]).toMatchObject({ action: "WEBSITE_IMAGE_UPDATED", userId: null, userEmail: "system:set-website-images" })
    expect(readdirSync(path.join(root, "tenant-1"))).toHaveLength(3)
    expect(await applyImageDir(db, { tenantId: "tenant-1", entries, root })).toEqual({ ok: true, written: [], unchanged: ["hero", "product-personal", "community"] })
    expect(state.audit).toHaveLength(3)
  })

  it("stops at the first refusal and names the file", async () => {
    file("hero.jpg", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1"))
    manifest({ hero: { alt: "x" } })
    mkdirSync(path.join(root, "tenant-1"), { recursive: true })
    const { db, state } = memoryDb()
    const result = await applyImageDir(db, { tenantId: "tenant-1", entries: loadImageDir(dir).entries, root })
    expect(result).toEqual({ ok: false, error: "hero.jpg: The image must be a JPEG, PNG or WebP file." })
    expect(state.doc).toBeNull()
    expect(state.audit).toEqual([])
  })
})
