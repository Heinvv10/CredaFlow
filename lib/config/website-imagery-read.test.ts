import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock("@/lib/observability/logger", () => ({ logger }))

import {
  StoredImageryUnreadable,
  getWebsiteImageryDocument,
  getWebsiteImageryView,
  readWebsiteImage,
  removeWebsiteImage,
  setWebsiteImage,
  updateWebsiteImageText,
} from "./website-imagery"
import { memoryDb } from "./__fixtures__/imagery-db"
import { realImage } from "./__fixtures__/real-images"

const ACTOR = { id: "admin-1", email: "admin@acme-lending.example" }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

let root = ""
let hero: Buffer
let card: Buffer
beforeAll(async () => {
  hero = await realImage(2400, 1350, "jpeg")
  card = await realImage(640, 360, "png")
})
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "website-imagery-read-"))
  vi.clearAllMocks()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

// A column that holds something, but not a document of this shape (an old shape, a hand edit, a bad migration).
const NOT_IN_SHAPE = { hero: { sha256: "a".repeat(64), format: "jpeg", width: 100, height: 100, alt: "kept" }, banner: { alt: "an unknown slot" } }

describe("a stored document that does not match the shape", () => {
  it.each([
    ["set", (db: ReturnType<typeof memoryDb>["db"]) => setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "product-personal", bytes: card, text: {}, root })],
    ["update", (db: ReturnType<typeof memoryDb>["db"]) => updateWebsiteImageText(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", text: { alt: "x" } })],
    ["remove", (db: ReturnType<typeof memoryDb>["db"]) => removeWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero" })],
  ])("is never written over by a %s: it throws, logs, leaves the column and the audit trail alone", async (_what, write) => {
    const { db, state } = memoryDb({ "tenant-1": NOT_IN_SHAPE })
    await expect(write(db)).rejects.toBeInstanceOf(StoredImageryUnreadable)
    expect(state.docs["tenant-1"]).toEqual(NOT_IN_SHAPE)
    expect(state.audit).toEqual([])
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("does not match its shape"), { tenantId: "tenant-1" })
  })

  it("is logged, not hidden, when read, and then shows no images", async () => {
    const reader = { tenantConfig: { findUnique: async () => ({ websiteImagery: NOT_IN_SHAPE }) } }
    expect(await getWebsiteImageryDocument("tenant-1", reader)).toBeNull()
    expect(await getWebsiteImageryView("tenant-1", { db: reader, root })).toBeNull()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("does not match its shape"), { tenantId: "tenant-1" })
  })

  it("does not log for an empty column or an empty document", async () => {
    for (const value of [null, {}]) {
      await getWebsiteImageryDocument("tenant-1", { tenantConfig: { findUnique: async () => ({ websiteImagery: value }) } })
    }
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe("reading", () => {
  async function seeded() {
    const m = memoryDb()
    await setWebsiteImage(m.db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: hero, text: { alt: "A hero" }, root })
    await setWebsiteImage(m.db, { tenantId: "tenant-1", actor: ACTOR, slot: "product-personal", bytes: card, text: {}, root })
    await setWebsiteImage(m.db, { tenantId: "tenant-1", actor: ACTOR, slot: "community", bytes: card, text: { alt: "Street", heading: "Our street", body: "We live here." }, root })
    const db = { tenantConfig: { findUnique: async ({ where }: { where: { tenantId: string } }) => ({ websiteImagery: m.state.docs[where.tenantId] ?? null }) } }
    return { db }
  }

  it("builds the page's view: both served widths in srcSet, versioned URLs, alt text ('' for a decorative card) and the community words", async () => {
    const { db } = await seeded()
    const v = sha(hero).slice(0, 12)
    const view = await getWebsiteImageryView("tenant-1", { db, root })
    expect(view?.hero).toEqual({
      src: `/api/website/imagery/hero?v=${v}&w=1920`,
      srcSet: `/api/website/imagery/hero?v=${v}&w=800 800w, /api/website/imagery/hero?v=${v}&w=1920 1920w`,
      alt: "A hero", width: 1920, height: 1080,
    })
    expect(view?.products.personal).toMatchObject({ alt: "", width: 640, height: 360 })
    expect(view?.community).toMatchObject({ alt: "Street", heading: "Our street", body: "We live here." })
  })

  it("is null with no imagery, for another tenant, and (logged) when the read fails", async () => {
    const { db } = await seeded()
    expect(await getWebsiteImageryView("tenant-2", { db, root })).toBeNull()
    const failing = { tenantConfig: { findUnique: async () => { throw new Error("db down") } } }
    expect(await getWebsiteImageryView("tenant-1", { db: failing, root })).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not be read"), { reason: "db down" })
  })

  it("leaves out a slot whose served file is gone", async () => {
    const { db } = await seeded()
    rmSync(path.join(root, "tenant-1", `${sha(hero)}.w1920.webp`))
    const view = await getWebsiteImageryView("tenant-1", { db, root })
    expect(view?.hero).toBeUndefined()
    expect(view?.community).toBeDefined()
  })

  it("serves the 800 or 1920 px WebP copy, never the upload, and never another tenant's", async () => {
    const { db } = await seeded()
    const big = await readWebsiteImage("tenant-1", "hero", { db, root })
    const little = await readWebsiteImage("tenant-1", "hero", { db, root, width: 800 })
    expect(big).toMatchObject({ mime: "image/webp", sha256: sha(hero) })
    expect(big?.bytes.length).toBeGreaterThan(little?.bytes.length ?? Infinity)
    expect(Buffer.from(big!.bytes).subarray(0, 4).toString("latin1")).toBe("RIFF")
    expect(Buffer.from(big!.bytes)).not.toEqual(hero)
    expect(await readWebsiteImage("tenant-2", "hero", { db, root })).toBeUndefined()
    expect(await readWebsiteImage("tenant-1", "product-short-term", { db, root })).toBeUndefined()
  })
})
