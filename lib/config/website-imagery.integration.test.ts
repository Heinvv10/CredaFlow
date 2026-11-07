/**
 * Real-Postgres proof of the website-imagery path: two tenants, writes that land
 * in the right TenantConfig row with their audit rows in the same transaction,
 * SQL NULL (not JSON null) once the last slot is removed, and a stored document
 * that is not in shape being refused rather than written over.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/config/website-imagery.integration.test.ts
 */
import { Prisma, PrismaClient } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { StoredImageryUnreadable, getWebsiteImageryView, removeWebsiteImage, setWebsiteImage, updateWebsiteImageText, type ImageryWriteDb } from "./website-imagery"
import { realImage } from "./__fixtures__/real-images"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const writeDb = db as unknown as ImageryWriteDb
const readDb = db as unknown as NonNullable<Parameters<typeof getWebsiteImageryView>[1]>["db"]

suite("website imagery (real DB)", () => {
  const tenants = [{ id: "", slug: `img-it-a-${randomUUID()}` }, { id: "", slug: `img-it-b-${randomUUID()}` }]
  const actor = { id: "", email: `img-it-${randomUUID()}@acme-lending.example` }
  let root = ""
  let heroA: Buffer
  let heroB: Buffer
  let card: Buffer

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "imagery-it-"))
    heroA = await realImage(1000, 500, "jpeg")
    heroB = await realImage(1000, 500, "jpeg", { rgb: [10, 20, 200] })
    card = await realImage(400, 225, "png")
    for (const t of tenants) t.id = (await db.tenant.create({ data: { slug: t.slug, name: "Imagery IT" } })).id
    actor.id = (await db.user.create({ data: { tenantId: tenants[0].id, email: actor.email, password: "not-a-login", role: "ADMIN" } })).id
  })

  afterAll(async () => {
    // Both tenants' audit rows name the one actor, so every row goes before the user does.
    for (const t of tenants) if (t.id) await purgeAuditRowsForTest(db, { tenantId: t.id })
    for (const t of tenants) {
      if (!t.id) continue
      await db.tenantConfig.deleteMany({ where: { tenantId: t.id } })
      await db.user.deleteMany({ where: { tenantId: t.id } })
      await db.tenant.delete({ where: { id: t.id } })
    }
    rmSync(root, { recursive: true, force: true })
    await db.$disconnect()
  })

  const [a, b] = tenants
  const column = (tenantId: string) => db.$queryRaw<Array<{ doc: unknown; isnull: boolean }>>`
    SELECT "websiteImagery" AS doc, "websiteImagery" IS NULL AS isnull FROM "TenantConfig" WHERE "tenantId" = ${tenantId}`
  const audit = (tenantId: string) => db.auditLog.findMany({ where: { tenantId, action: { startsWith: "WEBSITE_IMAGE_" } }, orderBy: { createdAt: "asc" } })

  it("a write creates the tenant's config row, stores the slot, and writes one audit row with it", async () => {
    const result = await setWebsiteImage(writeDb, { tenantId: a.id, actor, slot: "hero", bytes: heroA, text: { alt: "A hero" }, root })
    expect(result).toMatchObject({ ok: true, changed: true })
    const [row] = await column(a.id)
    expect(row.doc).toMatchObject({ hero: { alt: "A hero", format: "jpeg", width: 1000, height: 500 } })
    const rows = await audit(a.id)
    expect(rows).toEqual([expect.objectContaining({ action: "WEBSITE_IMAGE_UPDATED", entityId: a.id, userId: actor.id, userEmail: actor.email })])
    expect(rows[0].newValue).toMatchObject({ slot: "hero", image: { alt: "A hero" } })
  })

  it("the second tenant's images and audit rows are its own; neither touches the other's row", async () => {
    await setWebsiteImage(writeDb, { tenantId: b.id, actor, slot: "hero", bytes: heroB, text: { alt: "B hero" }, root })
    await setWebsiteImage(writeDb, { tenantId: b.id, actor, slot: "product-personal", bytes: card, text: {}, root })
    expect(((await column(a.id))[0].doc as { hero: { alt: string } }).hero.alt).toBe("A hero")
    expect((await column(b.id))[0].doc).toMatchObject({ hero: { alt: "B hero" }, products: { personal: { format: "png" } } })
    expect(await audit(a.id)).toHaveLength(1)
    expect(await audit(b.id)).toHaveLength(2)
    expect((await getWebsiteImageryView(a.id, { db: readDb, root }))?.hero?.alt).toBe("A hero")
    expect((await getWebsiteImageryView(b.id, { db: readDb, root }))?.hero?.alt).toBe("B hero")
  })

  it("a text edit is audited with the old and new alt text", async () => {
    expect(await updateWebsiteImageText(writeDb, { tenantId: a.id, actor, slot: "hero", text: { alt: "A new hero alt" } })).toEqual({ ok: true, changed: true })
    const last = (await audit(a.id)).at(-1)
    expect(last).toMatchObject({ action: "WEBSITE_IMAGE_UPDATED", oldValue: { image: { alt: "A hero" } }, newValue: { image: { alt: "A new hero alt" } } })
  })

  it("removing one slot keeps the others; removing the last sets SQL NULL, not JSON null, and audits each removal", async () => {
    await removeWebsiteImage(writeDb, { tenantId: b.id, actor, slot: "hero" })
    const [afterOne] = await column(b.id)
    expect(afterOne.isnull).toBe(false)
    expect(afterOne.doc).toMatchObject({ products: { personal: {} } })
    expect(afterOne.doc).not.toHaveProperty("hero")

    await removeWebsiteImage(writeDb, { tenantId: b.id, actor, slot: "product-personal" })
    const [afterLast] = await column(b.id)
    expect(afterLast.isnull).toBe(true)
    expect((await audit(b.id)).map((r) => r.action)).toEqual(["WEBSITE_IMAGE_UPDATED", "WEBSITE_IMAGE_UPDATED", "WEBSITE_IMAGE_REMOVED", "WEBSITE_IMAGE_REMOVED"])
    expect(await getWebsiteImageryView(b.id, { db: readDb, root })).toBeNull()
    expect((await column(a.id))[0].isnull).toBe(false)
  })

  it("a column that is not in shape is refused, untouched and unaudited, by set, update and remove", async () => {
    const broken = { hero: { alt: "kept" }, banner: { alt: "an unknown slot" } }
    await db.$executeRaw`UPDATE "TenantConfig" SET "websiteImagery" = ${JSON.stringify(broken)}::jsonb WHERE "tenantId" = ${b.id}`
    const before = (await audit(b.id)).length
    await expect(setWebsiteImage(writeDb, { tenantId: b.id, actor, slot: "hero", bytes: heroB, text: { alt: "x" }, root })).rejects.toBeInstanceOf(StoredImageryUnreadable)
    await expect(updateWebsiteImageText(writeDb, { tenantId: b.id, actor, slot: "hero", text: { alt: "x" } })).rejects.toBeInstanceOf(StoredImageryUnreadable)
    await expect(removeWebsiteImage(writeDb, { tenantId: b.id, actor, slot: "hero" })).rejects.toBeInstanceOf(StoredImageryUnreadable)
    expect((await column(b.id))[0].doc).toEqual(broken)
    expect(await audit(b.id)).toHaveLength(before)
  })

  it("the demo loader refuses a tenant that is not a demo lender, writing nothing; it accepts one that is", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "imagery-it-dir-"))
    try {
      writeFileSync(path.join(dir, "hero.jpg"), heroA)
      writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ hero: { alt: "Loader hero" } }))
      const run = () => spawnSync(path.join(process.cwd(), "node_modules/.bin/tsx"), ["scripts/demo/set-website-images.ts", b.slug, dir], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, HOME: dir, DEMO_MODE: "true" },
      })
      await db.tenantConfig.upsert({ where: { tenantId: b.id }, update: { isDemoLender: false, websiteImagery: Prisma.DbNull }, create: { tenantId: b.id } })
      const refused = run()
      expect(refused.status).toBe(2)
      expect(refused.stderr).toContain("is not a demo lender")
      expect((await column(b.id))[0].isnull).toBe(true)
      expect(existsSync(path.join(process.cwd(), "uploads", "website-imagery", b.id))).toBe(false)

      await db.tenantConfig.update({ where: { tenantId: b.id }, data: { isDemoLender: true } })
      const loaded = run()
      expect(loaded.status).toBe(0)
      expect(loaded.stderr).toContain(path.join("uploads", "website-imagery", b.id))
      expect((await column(b.id))[0].doc).toMatchObject({ hero: { alt: "Loader hero" } })
      expect((await audit(b.id)).at(-1)).toMatchObject({ userId: null, userEmail: "system:set-website-images" })
    } finally {
      rmSync(path.join(process.cwd(), "uploads", "website-imagery", b.id), { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
