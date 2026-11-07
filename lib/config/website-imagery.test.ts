import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Prisma } from "@prisma/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getWebsiteImageryView,
  readWebsiteImage,
  removeWebsiteImage,
  setWebsiteImage,
  updateWebsiteImageText,
  type ImageryWriteDb,
} from "./website-imagery"
import { parseWebsiteImagery } from "./website-imagery-schema"
import { makeJpeg, makeWebp } from "./__fixtures__/images"
import { makePng } from "./__fixtures__/png"

const ACTOR = { id: "admin-1", email: "admin@acme-lending.example" }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const ALT = "Two people at a kitchen table"

let root = ""
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "website-imagery-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

type AuditRow = { tenantId: string; action: string; entity: string; entityId: string | null; oldValue: unknown; newValue: unknown; userId: string | null; userEmail: string | null }
/** In-memory TenantConfig (one row per tenant) whose transaction only commits when the callback returns. */
function memoryDb(initial: Record<string, unknown> = {}, opts: { failAudit?: boolean } = {}) {
  const state = { docs: { ...initial } as Record<string, unknown>, audit: [] as AuditRow[], locked: 0 }
  const db = {
    tenantConfig: { findUnique: async ({ where }: { where: { tenantId: string } }) => ({ websiteImagery: state.docs[where.tenantId] ?? null }) },
    async $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const staged = { docs: { ...state.docs }, audit: [...state.audit] }
      const tx = {
        $executeRaw: async () => {
          state.locked++
          return 0
        },
        tenantConfig: {
          findUnique: async ({ where }: { where: { tenantId: string } }) => ({ websiteImagery: staged.docs[where.tenantId] ?? null }),
          upsert: async ({ where, update }: { where: { tenantId: string }; update: { websiteImagery: unknown } }) => {
            staged.docs[where.tenantId] = update.websiteImagery === Prisma.DbNull ? null : update.websiteImagery
            return {}
          },
        },
        auditLog: {
          create: async ({ data }: { data: AuditRow }) => {
            if (opts.failAudit) throw new Error("audit insert failed")
            staged.audit.push(data)
            return data
          },
        },
      }
      const result = await fn(tx as never)
      state.docs = staged.docs
      state.audit = staged.audit
      return result
    },
  }
  return { db: db as unknown as ImageryWriteDb, state }
}

const filesOf = (tenantId: string) => (existsSync(path.join(root, tenantId)) ? readdirSync(path.join(root, tenantId)) : [])
const doc = (state: { docs: Record<string, unknown> }, tenantId = "tenant-1") => parseWebsiteImagery(state.docs[tenantId])

describe("setWebsiteImage", () => {
  it("stores a JPEG under its tenant and hash, records it in the slot with its alt text, and audits in the same transaction", async () => {
    const jpeg = makeJpeg(1600, 900)
    const { db, state } = memoryDb()
    const result = await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: jpeg, text: { alt: ALT }, ipAddress: "10.0.0.1", root })
    expect(result).toEqual({ ok: true, changed: true, sha256: sha(jpeg) })
    expect(readFileSync(path.join(root, "tenant-1", `${sha(jpeg)}.jpg`))).toEqual(jpeg)
    expect(doc(state)).toEqual({ hero: { sha256: sha(jpeg), format: "jpeg", width: 1600, height: 900, alt: ALT } })
    expect(state.locked).toBe(1)
    expect(state.audit).toEqual([
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "WEBSITE_IMAGE_UPDATED",
        entity: "TenantConfig",
        entityId: "tenant-1",
        userId: "admin-1",
        userEmail: ACTOR.email,
        oldValue: { slot: "hero", image: null },
        newValue: { slot: "hero", image: { sha256: sha(jpeg), format: "jpeg", width: 1600, height: 900, alt: ALT } },
      }),
    ])
  })

  it("keeps the other slots when one is set, and files PNG and WebP under their own extensions", async () => {
    const { db, state } = memoryDb()
    const png = makePng(640, 360)
    const webp = makeWebp(800, 450)
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "product-personal", bytes: png, text: { alt: "Card" }, root })
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "community", bytes: webp, text: { alt: "Street", heading: "Our street", body: "We live here." }, root })
    expect(doc(state)).toMatchObject({
      products: { personal: { sha256: sha(png), format: "png" } },
      community: { sha256: sha(webp), format: "webp", heading: "Our street", body: "We live here." },
    })
    expect(filesOf("tenant-1").sort()).toEqual([`${sha(png)}.png`, `${sha(webp)}.webp`].sort())
  })

  it("replaces a slot's image, audits old and new, and keeps the old file", async () => {
    const first = makeJpeg(1600, 900)
    const second = makeJpeg(1920, 1080)
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: first, text: { alt: "One" }, root })
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: second, text: { alt: "Two" }, root })
    expect(doc(state)?.hero?.sha256).toBe(sha(second))
    expect(state.audit[1]).toMatchObject({ oldValue: { slot: "hero", image: { sha256: sha(first), alt: "One" } }, newValue: { slot: "hero", image: { sha256: sha(second), alt: "Two" } } })
    expect(filesOf("tenant-1")).toHaveLength(2)
  })

  it("does nothing, and writes no audit row, when the same image and text are set again", async () => {
    const jpeg = makeJpeg(1600, 900)
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: jpeg, text: { alt: ALT }, root })
    expect(await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: jpeg, text: { alt: ALT }, root })).toEqual({ ok: true, changed: false, sha256: sha(jpeg) })
    expect(state.audit).toHaveLength(1)
  })

  it.each([
    ["no alt text", { }],
    ["blank alt text", { alt: "  " }],
    ["alt text over 200 characters", { alt: "x".repeat(201) }],
    ["a heading on a hero", { alt: "ok", heading: "Welcome" }],
  ])("refuses %s and stores nothing", async (_what, text) => {
    const { db, state } = memoryDb()
    const result = await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: makeJpeg(100, 100), text, root })
    expect(result).toMatchObject({ ok: false })
    expect(state.docs).toEqual({})
    expect(state.audit).toEqual([])
    expect(filesOf("tenant-1")).toEqual([])
  })

  it("refuses a community band without its heading and sentence", async () => {
    const { db, state } = memoryDb()
    const result = await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "community", bytes: makeJpeg(100, 100), text: { alt: "ok", heading: "Only a heading" }, root })
    expect(result).toEqual({ ok: false, error: "The community band needs a heading and a sentence." })
    expect(state.audit).toEqual([])
  })

  it.each([
    ["a GIF", Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1")],
    ["an SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ["a file over 3 MB", makeJpeg(800, 600, { padding: 3 * 1024 * 1024 })],
    ["a 7000 px image", makePng(7000, 100)],
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
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: makeJpeg(100, 100), text: { alt: ALT }, root })
    expect(state.docs["tenant-2"]).toEqual(other)
    expect(filesOf("tenant-2")).toEqual([])
    expect(state.audit.every((row) => row.tenantId === "tenant-1")).toBe(true)
  })

  it("files each tenant's image under its own directory, and each tenant's document under its own row", async () => {
    const mine = makeJpeg(100, 100)
    const theirs = makeJpeg(120, 120)
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: mine, text: { alt: "Mine" }, root })
    await setWebsiteImage(db, { tenantId: "tenant-2", actor: ACTOR, slot: "hero", bytes: theirs, text: { alt: "Theirs" }, root })
    expect(filesOf("tenant-1")).toEqual([`${sha(mine)}.jpg`])
    expect(filesOf("tenant-2")).toEqual([`${sha(theirs)}.jpg`])
    expect(doc(state, "tenant-1")?.hero?.alt).toBe("Mine")
    expect(doc(state, "tenant-2")?.hero?.alt).toBe("Theirs")
    expect(state.audit.map((row) => row.tenantId)).toEqual(["tenant-1", "tenant-2"])
  })

  it.each(["../tenant-2", "a/b", "", "x".repeat(65)])("refuses the unsafe tenant id %j before touching the disk", async (tenantId) => {
    const { db } = memoryDb()
    await expect(setWebsiteImage(db, { tenantId, actor: ACTOR, slot: "hero", bytes: makeJpeg(100, 100), text: { alt: ALT }, root })).rejects.toThrow(/unsafe tenant id/)
    expect(readdirSync(root)).toEqual([])
  })

  it("commits nothing when the audit row cannot be written", async () => {
    const { db, state } = memoryDb({}, { failAudit: true })
    await expect(setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: makeJpeg(100, 100), text: { alt: ALT }, root })).rejects.toThrow(/audit insert failed/)
    expect(state.docs).toEqual({})
  })
})

describe("updateWebsiteImageText", () => {
  it("changes the alt text of a slot that has an image, audited, without touching the file", async () => {
    const jpeg = makeJpeg(1600, 900)
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: jpeg, text: { alt: "Old" }, root })
    expect(await updateWebsiteImageText(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", text: { alt: "New" } })).toEqual({ ok: true, changed: true })
    expect(doc(state)?.hero).toMatchObject({ sha256: sha(jpeg), alt: "New" })
    expect(state.audit[1]).toMatchObject({ action: "WEBSITE_IMAGE_UPDATED", oldValue: { image: { alt: "Old" } }, newValue: { image: { alt: "New" } } })
  })

  it("refuses an empty slot and missing alt text", async () => {
    const { db, state } = memoryDb()
    expect(await updateWebsiteImageText(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", text: { alt: "x" } })).toMatchObject({ ok: false, error: expect.stringMatching(/no image/) })
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: makeJpeg(100, 100), text: { alt: "Old" }, root })
    expect(await updateWebsiteImageText(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", text: { alt: "" } })).toMatchObject({ ok: false })
    expect(doc(state)?.hero?.alt).toBe("Old")
  })
})

describe("removeWebsiteImage", () => {
  it("empties the slot, nulls the column with the last one, and audits", async () => {
    const jpeg = makeJpeg(1600, 900)
    const { db, state } = memoryDb()
    await setWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: jpeg, text: { alt: ALT }, root })
    expect(await removeWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero" })).toEqual({ ok: true, changed: true })
    expect(state.docs["tenant-1"]).toBeNull()
    expect(state.audit[1]).toMatchObject({ action: "WEBSITE_IMAGE_REMOVED", oldValue: { slot: "hero", image: { sha256: sha(jpeg) } }, newValue: { slot: "hero", image: null } })
  })

  it("does nothing for an empty slot", async () => {
    const { db, state } = memoryDb()
    expect(await removeWebsiteImage(db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero" })).toEqual({ ok: true, changed: false })
    expect(state.audit).toEqual([])
  })
})

describe("reading", () => {
  async function seeded() {
    const jpeg = makeJpeg(1600, 900)
    const m = memoryDb()
    await setWebsiteImage(m.db, { tenantId: "tenant-1", actor: ACTOR, slot: "hero", bytes: jpeg, text: { alt: ALT }, root })
    await setWebsiteImage(m.db, { tenantId: "tenant-1", actor: ACTOR, slot: "community", bytes: makePng(900, 600), text: { alt: "Street", heading: "Our street", body: "We live here." }, root })
    const db = { tenantConfig: { findUnique: async ({ where }: { where: { tenantId: string } }) => ({ websiteImagery: m.state.docs[where.tenantId] ?? null }) } }
    return { jpeg, db, state: m.state }
  }

  it("builds the page's view: versioned URLs, alt text and the community words, only for slots with a file", async () => {
    const { jpeg, db } = await seeded()
    const view = await getWebsiteImageryView("tenant-1", { db, root })
    expect(view).toEqual({
      hero: { src: `/api/website/imagery/hero?v=${sha(jpeg).slice(0, 12)}`, alt: ALT, width: 1600, height: 900 },
      products: {},
      community: { src: expect.stringMatching(/^\/api\/website\/imagery\/community\?v=[0-9a-f]{12}$/), alt: "Street", width: 900, height: 600, heading: "Our street", body: "We live here." },
    })
  })

  it("is null with no imagery, for another tenant, and when the read fails", async () => {
    const { db } = await seeded()
    expect(await getWebsiteImageryView("tenant-2", { db, root })).toBeNull()
    const failing = { tenantConfig: { findUnique: async () => { throw new Error("db down") } } }
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    expect(await getWebsiteImageryView("tenant-1", { db: failing, root })).toBeNull()
  })

  it("leaves out a slot whose file is gone", async () => {
    const { jpeg, db } = await seeded()
    rmSync(path.join(root, "tenant-1", `${sha(jpeg)}.jpg`))
    const view = await getWebsiteImageryView("tenant-1", { db, root })
    expect(view?.hero).toBeUndefined()
    expect(view?.community).toBeDefined()
  })

  it("serves the bytes, but not a file that no longer matches its hash, and never another tenant's", async () => {
    const { jpeg, db } = await seeded()
    expect(await readWebsiteImage("tenant-1", "hero", { db, root })).toEqual({ bytes: new Uint8Array(jpeg), mime: "image/jpeg", sha256: sha(jpeg) })
    expect(await readWebsiteImage("tenant-2", "hero", { db, root })).toBeUndefined()
    expect(await readWebsiteImage("tenant-1", "product-personal", { db, root })).toBeUndefined()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
    writeFileSync(path.join(root, "tenant-1", `${sha(jpeg)}.jpg`), makeJpeg(10, 10))
    expect(await readWebsiteImage("tenant-1", "hero", { db, root })).toBeUndefined()
  })
})
