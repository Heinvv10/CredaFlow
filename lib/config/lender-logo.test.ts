import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  LOGO_MAX_BYTES,
  getLenderLogo,
  logoReference,
  removeLenderLogo,
  setLenderLogo,
  validateLogoPng,
  type LogoWriteDb,
} from "./lender-logo"
import { makePng } from "./__fixtures__/png"
import { PDFDocument } from "pdf-lib"
import { crc32 } from "node:zlib"

const ACTOR = { id: "admin-1", email: "admin@acme-lending.example" }
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

let root = ""
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "lender-logo-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("validateLogoPng", () => {
  it("accepts a real PNG and reports its size", async () => {
    expect(await validateLogoPng(makePng(240, 80))).toEqual({ ok: true, width: 240, height: 80 })
  })

  it("refuses a JPEG renamed to .png (checked by content, not name)", async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])
    expect(await validateLogoPng(jpeg)).toMatchObject({ ok: false, error: expect.stringMatching(/PNG/) })
  })

  it("refuses a file with a PNG signature that pdf-lib cannot embed", async () => {
    const broken = Buffer.concat([makePng(10, 10).subarray(0, 8), Buffer.from("not a png body")])
    expect(await validateLogoPng(broken)).toMatchObject({ ok: false })
  })

  it("refuses a file over 512 KB", async () => {
    const big = makePng(500, 400, { noise: true })
    expect(big.length).toBeGreaterThan(LOGO_MAX_BYTES)
    expect(await validateLogoPng(big)).toMatchObject({ ok: false, error: expect.stringMatching(/512 KB/) })
  })

  // A few KB of PNG can declare a huge image that decodes to gigabytes, so
  // the declared size is checked before anything decodes it.
  it("refuses a PNG that declares more than 2000x2000 pixels without decoding it", async () => {
    const png = makePng(20, 20)
    png.writeUInt32BE(40000, 16)
    png.writeUInt32BE(40000, 20)
    png.writeUInt32BE(crc32(png.subarray(12, 29)), 29) // keep the IHDR chunk's CRC valid
    const embed = vi.spyOn(PDFDocument.prototype, "embedPng")
    expect(await validateLogoPng(png)).toMatchObject({ ok: false, error: expect.stringMatching(/2000/) })
    expect(embed).not.toHaveBeenCalled()
  })

  // The documents scale a logo to fit their letterhead; past 8:1 it would
  // print as an unreadable sliver, so such a shape is refused at upload.
  it.each([[1700, 200], [200, 1700]])("refuses a %ix%i logo (more than 8:1)", async (w, h) => {
    expect(await validateLogoPng(makePng(w, h))).toMatchObject({ ok: false, error: expect.stringMatching(/8:1/) })
  })

  it("accepts an 8:1 logo", async () => {
    expect(await validateLogoPng(makePng(1600, 200))).toEqual({ ok: true, width: 1600, height: 200 })
  })

  it.each([[2001, 300], [300, 2001]])("refuses %ix%i pixels", async (w, h) => {
    expect(await validateLogoPng(makePng(w, h))).toMatchObject({ ok: false, error: expect.stringMatching(/2000/) })
  })
})

type AuditRow = { action: string; entity: string; entityId: string | null; oldValue: unknown; newValue: unknown; userId: string | null }

/** In-memory db whose transaction only commits when the callback returns. */
function memoryDb(logoUrl: string | null, opts: { failAudit?: boolean } = {}) {
  const state = { logoUrl, audit: [] as AuditRow[], locked: 0 }
  const db = {
    tenantConfig: { findUnique: async () => ({ logoUrl: state.logoUrl }) },
    async $transaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const staged = { logoUrl: state.logoUrl, audit: [...state.audit] }
      const tx = {
        $executeRaw: async () => {
          state.locked++
          return 0
        },
        tenantConfig: {
          findUnique: async () => ({ logoUrl: staged.logoUrl }),
          upsert: async ({ update, create }: { update: { logoUrl: string | null }; create: { logoUrl: string | null } }) => {
            staged.logoUrl = (update ?? create).logoUrl
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
      state.logoUrl = staged.logoUrl
      state.audit = staged.audit
      return result
    },
  }
  return { db: db as unknown as LogoWriteDb, state }
}

describe("setLenderLogo", () => {
  it("stores the PNG under its tenant and hash, points logoUrl at it, and audits in the same transaction", async () => {
    const png = makePng(240, 80)
    const { db, state } = memoryDb(null)
    const result = await setLenderLogo(db, { tenantId: "tenant-1", actor: ACTOR, bytes: png, root })
    expect(result).toEqual({ ok: true, changed: true, sha256: sha(png) })
    expect(readFileSync(path.join(root, "tenant-1", `${sha(png)}.png`))).toEqual(png)
    expect(state.logoUrl).toBe(logoReference(sha(png)))
    expect(state.logoUrl).not.toMatch(/^https?:|^\//)
    expect(state.locked).toBe(1)
    expect(state.audit).toEqual([
      expect.objectContaining({
        action: "LENDER_LOGO_UPDATED",
        entity: "TenantConfig",
        entityId: "tenant-1",
        userId: "admin-1",
        oldValue: { logoSha256: null },
        newValue: { logoSha256: sha(png), width: 240, height: 80, bytes: png.length },
      }),
    ])
  })

  it("writes no file, no logoUrl and no audit row for an invalid upload", async () => {
    const { db, state } = memoryDb(null)
    const result = await setLenderLogo(db, { tenantId: "tenant-1", actor: ACTOR, bytes: Buffer.from("GIF89a....."), root })
    expect(result).toMatchObject({ ok: false, error: expect.any(String) })
    expect(state.logoUrl).toBeNull()
    expect(state.audit).toHaveLength(0)
    expect(readdirSync(root)).toEqual([])
  })

  it("does not change logoUrl when the audit row cannot be written", async () => {
    const { db, state } = memoryDb(null, { failAudit: true })
    await expect(setLenderLogo(db, { tenantId: "tenant-1", actor: ACTOR, bytes: makePng(20, 20), root })).rejects.toThrow(/audit/)
    expect(state.logoUrl).toBeNull()
  })

  it("re-uploading the current logo changes and audits nothing", async () => {
    const png = makePng(20, 20)
    const { db, state } = memoryDb(logoReference(sha(png)))
    expect(await setLenderLogo(db, { tenantId: "tenant-1", actor: ACTOR, bytes: png, root })).toEqual({ ok: true, changed: false, sha256: sha(png) })
    expect(state.audit).toHaveLength(0)
  })

  it.each(["../tenant-2", "a/b", "", "tenant 1"])("refuses an unsafe tenant id %j before touching the disk", async (tenantId) => {
    const { db } = memoryDb(null)
    await expect(setLenderLogo(db, { tenantId, actor: ACTOR, bytes: makePng(20, 20), root })).rejects.toThrow(/tenant id/)
    expect(readdirSync(root)).toEqual([])
  })
})

describe("removeLenderLogo", () => {
  it("clears logoUrl and audits the removal", async () => {
    const { db, state } = memoryDb(logoReference("a".repeat(64)))
    expect(await removeLenderLogo(db, { tenantId: "tenant-1", actor: ACTOR })).toEqual({ ok: true, changed: true })
    expect(state.logoUrl).toBeNull()
    expect(state.audit).toEqual([
      expect.objectContaining({ action: "LENDER_LOGO_REMOVED", oldValue: { logoSha256: "a".repeat(64) }, newValue: { logoSha256: null } }),
    ])
  })

  it("does nothing when there is no logo", async () => {
    const { db, state } = memoryDb(null)
    expect(await removeLenderLogo(db, { tenantId: "tenant-1", actor: ACTOR })).toEqual({ ok: true, changed: false })
    expect(state.audit).toHaveLength(0)
  })
})

describe("getLenderLogo", () => {
  function stored(png: Buffer, tenantId = "tenant-1") {
    mkdirSync(path.join(root, tenantId), { recursive: true })
    writeFileSync(path.join(root, tenantId, `${sha(png)}.png`), png)
  }
  const readDb = (logoUrl: string | null) => ({ tenantConfig: { findUnique: async () => ({ logoUrl }) } })

  it("returns the stored bytes", async () => {
    const png = makePng(30, 30)
    stored(png)
    expect(Buffer.from((await getLenderLogo("tenant-1", { db: readDb(logoReference(sha(png))), root }))!)).toEqual(png)
  })

  it("is undefined when no logo is set or the tenant has no config", async () => {
    expect(await getLenderLogo("tenant-1", { db: readDb(null), root })).toBeUndefined()
    expect(await getLenderLogo("tenant-1", { db: { tenantConfig: { findUnique: async () => null } }, root })).toBeUndefined()
  })

  it("is undefined, not a throw, when the file is missing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await getLenderLogo("tenant-1", { db: readDb(logoReference("b".repeat(64))), root })).toBeUndefined()
  })

  it("never fetches a URL stored in logoUrl", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
    vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await getLenderLogo("tenant-1", { db: readDb("https://evil.example/logo.png"), root })).toBeUndefined()
    expect(await getLenderLogo("tenant-1", { db: readDb("/etc/passwd"), root })).toBeUndefined()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("is undefined when the file on disk does not match its hash", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const png = makePng(30, 30)
    const ref = logoReference(sha(png))
    mkdirSync(path.join(root, "tenant-1"), { recursive: true })
    writeFileSync(path.join(root, "tenant-1", `${sha(png)}.png`), makePng(31, 30))
    expect(await getLenderLogo("tenant-1", { db: readDb(ref), root })).toBeUndefined()
  })

  it("reads only the asking tenant's directory", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const png = makePng(30, 30)
    stored(png, "tenant-2")
    expect(await getLenderLogo("tenant-1", { db: readDb(logoReference(sha(png))), root })).toBeUndefined()
    expect(existsSync(path.join(root, "tenant-2", `${sha(png)}.png`))).toBe(true)
  })
})
