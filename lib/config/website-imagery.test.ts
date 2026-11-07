import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { removeWebsiteImage, setWebsiteImage, updateWebsiteImageText } from "./website-imagery"
import { parseWebsiteImagery } from "./website-imagery-schema"
import { makeJpeg } from "./__fixtures__/images"
import { memoryDb } from "./__fixtures__/imagery-db"
import { makePng } from "./__fixtures__/png"
import { realImage } from "./__fixtures__/real-images"

const ACTOR = { id: "admin-1", email: "admin@acme-lending.example" }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const ALT = "Two people at a kitchen table"

let root = ""
let hero: Buffer
let heroTwo: Buffer
let small: Buffer
let smallTwo: Buffer
let png: Buffer
let webp: Buffer
beforeAll(async () => {
  hero = await realImage(2400, 1350, "jpeg")
  heroTwo = await realImage(2400, 1350, "jpeg", { rgb: [10, 90, 200] })
  small = await realImage(300, 200, "jpeg")
  smallTwo = await realImage(320, 200, "jpeg", { rgb: [30, 30, 30] })
  png = await realImage(640, 360, "png")
  webp = await realImage(800, 450, "webp")
})
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "website-imagery-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const filesOf = (tenantId: string) => (existsSync(path.join(root, tenantId)) ? readdirSync(path.join(root, tenantId)).sort() : [])
const doc = (state: { docs: Record<string, unknown> }, tenantId = "tenant-1") => parseWebsiteImagery(state.docs[tenantId])
const ofUpload = (bytes: Buffer, ext: string) => [`${sha(bytes)}.${ext}`, `${sha(bytes)}.w1920.webp`, `${sha(bytes)}.w800.webp`]

describe("setWebsiteImage", () => {
  it("stores the upload and its two served copies under the tenant and hash, records the slot with its alt text, and audits in the same transaction", async () => {
    const { db, state } = memoryDb()
    const result = await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: hero, text: { alt: ALT }, ipAddress: "10.0.0.1", root })
    expect(result).toEqual({ ok: true, changed: true, sha256: sha(hero) })
    expect(filesOf("tenant-1")).toEqual(ofUpload(hero, "jpg").sort())
    // The served copy of a 2400 px upload is 1920 px wide: the recorded size is the served one.
    const stored = { sha256: sha(hero), format: "jpeg", width: 1920, height: 1080, alt: ALT }
    expect(doc(state)).toEqual({ hero: stored })
    expect(state.locked).toBe(1)
    expect(state.audit).toEqual([
      expect.objectContaining({
        tenantId: "tenant-1", action: "WEBSITE_IMAGE_UPDATED", entity: "TenantConfig", entityId: "tenant-1",
        userId: "admin-1", userEmail: ACTOR.email,
        oldValue: { slot: "hero", image: null }, newValue: { slot: "hero", image: stored },
      }),
    ])
  })

  it("keeps the other slots when one is set, and files PNG and WebP uploads under their own extensions", async () => {
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "product-personal", bytes: png, text: { alt: "Card" }, root })
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "community", bytes: webp, text: { alt: "Street", heading: "Our street", body: "We live here." }, root })
    expect(doc(state)).toMatchObject({
      products: { personal: { sha256: sha(png), format: "png", width: 640, height: 360 } },
      community: { sha256: sha(webp), format: "webp", heading: "Our street", body: "We live here." },
    })
    expect(filesOf("tenant-1")).toEqual([...ofUpload(png, "png"), ...ofUpload(webp, "webp")].sort())
  })

  it("replaces a slot's image, audits old and new, and keeps the old files", async () => {
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: hero, text: { alt: "One" }, root })
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: heroTwo, text: { alt: "Two" }, root })
    expect(doc(state)?.hero?.sha256).toBe(sha(heroTwo))
    expect(state.audit[1]).toMatchObject({ oldValue: { slot: "hero", image: { sha256: sha(hero), alt: "One" } }, newValue: { slot: "hero", image: { sha256: sha(heroTwo), alt: "Two" } } })
    expect(filesOf("tenant-1")).toHaveLength(6)
  })

  it("does nothing, and writes no audit row, when the same image and text are set again", async () => {
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: hero, text: { alt: ALT }, root })
    expect(await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: hero, text: { alt: ALT }, root })).toEqual({ ok: true, changed: false, sha256: sha(hero) })
    expect(state.audit).toHaveLength(1)
  })

  it("accepts a product image without alt text (decorative), and stores none", async () => {
    const { db, state } = memoryDb()
    expect(await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "product-personal", bytes: small, text: {}, root })).toMatchObject({ ok: true, changed: true })
    expect(doc(state)?.products?.personal).toEqual({ sha256: sha(small), format: "jpeg", width: 300, height: 200 })
  })

  it.each([
    ["no alt text on a hero", "hero", {}],
    ["blank alt text on a hero", "hero", { alt: "  " }],
    ["no alt text on the community band", "community", { heading: "H", body: "B" }],
    ["alt text over 200 characters", "hero", { alt: "x".repeat(201) }],
    ["a heading on a hero", "hero", { alt: "ok", heading: "Welcome" }],
    ["a heading on a product card", "product-personal", { heading: "Welcome" }],
  ] as const)("refuses %s and stores nothing", async (_what, slot, text) => {
    const { db, state } = memoryDb()
    const result = await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot, bytes: small, text, root })
    expect(result).toMatchObject({ ok: false })
    expect(state.docs).toEqual({})
    expect(state.audit).toEqual([])
    expect(filesOf("tenant-1")).toEqual([])
  })

  it("refuses a community band without its heading and sentence", async () => {
    const { db, state } = memoryDb()
    const result = await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "community", bytes: small, text: { alt: "ok", heading: "Only a heading" }, root })
    expect(result).toEqual({ ok: false, error: "The community band needs a heading and a sentence." })
    expect(state.audit).toEqual([])
  })

  it.each([
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1")],
    ["an SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["a file over 3 MB", makeJpeg(800, 600, { padding: 3 * 1024 * 1024 })],
    ["a 7000 px image", makePng(7000, 100)],
    ["a JPEG whose header is fine but whose pixels are not", makeJpeg(800, 600)],
  ])("refuses %s: no file, no document, no audit row", async (_what, bytes) => {
    const { db, state } = memoryDb()
    const result = await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes, text: { alt: ALT }, root })
    expect(result).toMatchObject({ ok: false })
    expect(state.docs).toEqual({})
    expect(state.audit).toEqual([])
    expect(filesOf("tenant-1")).toEqual([])
  })

  it("is tenant-scoped: writes only to the tenant it is given, leaves another tenant's document alone", async () => {
    const other = { hero: { sha256: "b".repeat(64), format: "jpeg", width: 10, height: 10, alt: "Other lender" } }
    const { db, state } = memoryDb({ "tenant-2": other })
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: small, text: { alt: ALT }, root })
    expect(state.docs["tenant-2"]).toEqual(other)
    expect(filesOf("tenant-2")).toEqual([])
    expect(state.audit.every((row) => row.tenantId === "tenant-1")).toBe(true)
  })

  it("files each tenant's images under its own directory, and each tenant's document under its own row", async () => {
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: small, text: { alt: "Mine" }, root })
    await setWebsiteImage(db, { tenantId: "tenant-2", actor: ACTOR, slot: "hero", bytes: smallTwo, text: { alt: "Theirs" }, root })
    expect(filesOf("tenant-1")).toEqual(ofUpload(small, "jpg").sort())
    expect(filesOf("tenant-2")).toEqual(ofUpload(smallTwo, "jpg").sort())
    expect(doc(state, "tenant-1")?.hero?.alt).toBe("Mine")
    expect(doc(state, "tenant-2")?.hero?.alt).toBe("Theirs")
    expect(state.audit.map((row) => row.tenantId)).toEqual(["tenant-1", "tenant-2"])
  })

  it.each(["../tenant-2", "a/b", "", "x".repeat(65)])("refuses the unsafe tenant id %j before touching the disk", async (tenantId) => {
    const { db } = memoryDb()
    await expect(setWebsiteImage(db, { tenantId, actor: ACTOR, slot: "hero", bytes: small, text: { alt: ALT }, root })).rejects.toThrow(/unsafe tenant id/)
    expect(readdirSync(root)).toEqual([])
  })

  it("commits nothing when the audit row cannot be written", async () => {
    const { db, state } = memoryDb({}, { failAudit: true })
    await expect(setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: small, text: { alt: ALT }, root })).rejects.toThrow(/audit insert failed/)
    expect(state.docs).toEqual({})
  })
})

describe("served copies", () => {
  it("are WebP at 800 and 1920 px wide (never enlarged), carry no metadata, and have the camera's orientation applied", async () => {
    const tagged = await realImage(3000, 2000, "jpeg", { withExif: true, orientation: 6 }) // stored sideways: displays 2000 x 3000
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: tagged, text: { alt: ALT }, root })
    const big = await sharp(path.join(root, "tenant-1", `${sha(tagged)}.w1920.webp`)).metadata()
    const little = await sharp(path.join(root, "tenant-1", `${sha(tagged)}.w800.webp`)).metadata()
    expect([big.format, big.width, big.height]).toEqual(["webp", 1920, 2880])
    expect([little.format, little.width, little.height]).toEqual(["webp", 800, 1200])
    expect(big.exif).toBeUndefined()
    expect(doc(state)?.hero).toMatchObject({ width: 1920, height: 2880 })

    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "product-personal", bytes: small, text: {}, root })
    expect((await sharp(path.join(root, "tenant-1", `${sha(small)}.w1920.webp`)).metadata()).width).toBe(300)
  })
})

describe("updateWebsiteImageText", () => {
  it("changes the alt text of a slot that has an image, audited, without touching the files", async () => {
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: small, text: { alt: "Old" }, root })
    const before = filesOf("tenant-1")
    expect(await updateWebsiteImageText(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", text: { alt: "New" } })).toEqual({ ok: true, changed: true })
    expect(doc(state)?.hero).toMatchObject({ sha256: sha(small), alt: "New" })
    expect(state.audit[1]).toMatchObject({ action: "WEBSITE_IMAGE_UPDATED", oldValue: { image: { alt: "Old" } }, newValue: { image: { alt: "New" } } })
    expect(filesOf("tenant-1")).toEqual(before)
  })

  it("refuses an empty slot and missing alt text on a hero", async () => {
    const { db, state } = memoryDb()
    expect(await updateWebsiteImageText(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", text: { alt: "x" } })).toMatchObject({ ok: false, error: expect.stringMatching(/no image/) })
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: small, text: { alt: "Old" }, root })
    expect(await updateWebsiteImageText(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", text: { alt: "" } })).toMatchObject({ ok: false })
    expect(doc(state)?.hero?.alt).toBe("Old")
  })

  it("lets a product card's alt text be cleared", async () => {
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "product-personal", bytes: small, text: { alt: "Card" }, root })
    expect(await updateWebsiteImageText(db, { tenantId: "tenant-1", actor: ACTOR, slot: "product-personal", text: { alt: "" } })).toEqual({ ok: true, changed: true })
    expect(doc(state)?.products?.personal?.alt).toBeUndefined()
  })
})

describe("removeWebsiteImage", () => {
  it("empties the slot, nulls the column with the last one, audits, and keeps the files", async () => {
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: small, text: { alt: ALT }, root })
    expect(await removeWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero" })).toEqual({ ok: true, changed: true })
    expect(state.docs["tenant-1"]).toBeNull()
    expect(state.audit[1]).toMatchObject({ action: "WEBSITE_IMAGE_REMOVED", oldValue: { slot: "hero", image: { sha256: sha(small) } }, newValue: { slot: "hero", image: null } })
    expect(filesOf("tenant-1")).toEqual(ofUpload(small, "jpg").sort())
  })

  it("does nothing for an empty slot", async () => {
    const { db, state } = memoryDb()
    expect(await removeWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero" })).toEqual({ ok: true, changed: false })
    expect(state.audit).toEqual([])
  })
})
