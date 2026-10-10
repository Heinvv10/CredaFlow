/**
 * Real-Postgres proof of the logo path: an upload writes the
 * file, sets logoUrl and one audit row together; the S129 notice the route
 * builds then embeds the image; removing the logo returns it to the text
 * letterhead.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/config/lender-logo.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { getLenderLogo, removeLenderLogo, setLenderLogo, type LogoWriteDb } from "./lender-logo"
import { buildSection129Attachments } from "@/lib/email/section129-attachments"
import { ACME_LENDER } from "./__fixtures__/lender-identity"
import { makePng } from "./__fixtures__/png"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const writeDb = db as unknown as LogoWriteDb
const readDb = db as unknown as NonNullable<Parameters<typeof getLenderLogo>[1]>["db"]

async function s129Pdf(tenantId: string, root: string): Promise<string> {
  const [attachment] = await buildSection129Attachments({
    lender: ACME_LENDER,
    logo: await getLenderLogo(tenantId, { db: readDb, root }),
    client: { firstName: "Synthetic", lastName: "Customer", idNumber: "9001015009087" },
    loan: { reference: "LN-IT-1", arrearsAmount: 150000, outstandingPrincipal: 500000, daysInArrears: 95 },
    noticeDate: new Date("2026-10-09T08:00:00Z"),
  })
  return Buffer.from(attachment.content as Buffer).toString("latin1")
}

suite("lender logo (real DB)", () => {
  let tenantId = ""
  let root = ""
  const actor = { id: "", email: `logo-it-${randomUUID()}@acme-lending.example` }
  const png = makePng(240, 80)

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "logo-it-"))
    const tenant = await db.tenant.create({ data: { slug: `logo-it-${randomUUID()}`, name: "Logo IT" } })
    tenantId = tenant.id
    const user = await db.user.create({ data: { tenantId, email: actor.email, password: "not-a-login", role: "ADMIN" } })
    actor.id = user.id
  })

  afterAll(async () => {
    if (tenantId) {
      await db.auditLog.deleteMany({ where: { tenantId } })
      await db.tenantConfig.deleteMany({ where: { tenantId } })
      await db.user.deleteMany({ where: { tenantId } })
      await db.tenant.delete({ where: { id: tenantId } })
    }
    rmSync(root, { recursive: true, force: true })
    await db.$disconnect()
  })

  const logoAudit = () => db.auditLog.findMany({ where: { tenantId, action: { startsWith: "LENDER_LOGO_" } }, orderBy: { createdAt: "asc" } })

  it("prints the text letterhead before any logo is uploaded", async () => {
    expect(await s129Pdf(tenantId, root)).not.toContain("/Subtype /Image")
  })

  it("an upload sets logoUrl to an internal reference with one audit row, and the S129 notice embeds it", async () => {
    const result = await setLenderLogo(writeDb, { tenantId, actor, bytes: png, root })
    expect(result).toMatchObject({ ok: true, changed: true })
    const config = await db.tenantConfig.findUnique({ where: { tenantId }, select: { logoUrl: true } })
    expect(config?.logoUrl).toMatch(/^tenant-logo:sha256:[0-9a-f]{64}$/)
    const rows = await logoAudit()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: "LENDER_LOGO_UPDATED", entity: "TenantConfig", entityId: tenantId, userId: actor.id })
    expect(await s129Pdf(tenantId, root)).toContain("/Subtype /Image")
  })

  it("an invalid upload changes nothing", async () => {
    const before = await db.tenantConfig.findUnique({ where: { tenantId }, select: { logoUrl: true } })
    expect(await setLenderLogo(writeDb, { tenantId, actor, bytes: Buffer.from("GIF89a"), root })).toMatchObject({ ok: false })
    expect(await db.tenantConfig.findUnique({ where: { tenantId }, select: { logoUrl: true } })).toEqual(before)
    expect(await logoAudit()).toHaveLength(1)
  })

  it("removing the logo is audited and the notice returns to the text letterhead", async () => {
    expect(await removeLenderLogo(writeDb, { tenantId, actor })).toEqual({ ok: true, changed: true })
    const rows = await logoAudit()
    expect(rows.map((r) => r.action)).toEqual(["LENDER_LOGO_UPDATED", "LENDER_LOGO_REMOVED"])
    expect(await s129Pdf(tenantId, root)).not.toContain("/Subtype /Image")
  })

  it("a logo whose file has gone prints the text letterhead rather than failing", async () => {
    await setLenderLogo(writeDb, { tenantId, actor, bytes: png, root })
    rmSync(path.join(root, tenantId), { recursive: true, force: true })
    expect(await s129Pdf(tenantId, root)).not.toContain("/Subtype /Image")
  })
})
