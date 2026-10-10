/**
 * Real-Postgres proof of the lender identity write path: an invalid write
 * leaves the row untouched, a valid write commits with exactly one audit row,
 * and the resolver reads back what was written.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/config/identity-write.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { updateLenderIdentity, type IdentityWriteDb } from "./identity-write"
import { getLenderIdentity, LenderIdentityError } from "./identity"
import { VALID_LENDER_COLUMNS } from "./__fixtures__/lender-identity"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
// The raw client has the same $transaction shape as the app's extended one.
const writeDb = db as unknown as IdentityWriteDb

const CONFIRMED = {
  ...VALID_LENDER_COLUMNS,
  ncrNumberConfirm: VALID_LENDER_COLUMNS.ncrNumber,
  fscaNumberConfirm: VALID_LENDER_COLUMNS.fscaNumber,
  companyRegNumberConfirm: VALID_LENDER_COLUMNS.companyRegNumber,
}

suite("lender identity write path (real DB)", () => {
  let tenantId = ""
  const actor = { id: "", email: `identity-it-${randomUUID()}@acme-lending.example` }

  beforeAll(async () => {
    const tenant = await db.tenant.create({ data: { slug: `identity-it-${randomUUID()}`, name: "Identity IT" } })
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
    await db.$disconnect()
  })

  const auditRows = () => db.auditLog.findMany({ where: { tenantId, action: "LENDER_IDENTITY_UPDATED" }, orderBy: { createdAt: "asc" } })

  it("resolver refuses before anything is configured", async () => {
    await expect(getLenderIdentity(tenantId, db)).rejects.toBeInstanceOf(LenderIdentityError)
  })

  it("an invalid write is rejected and nothing is persisted", async () => {
    const result = await updateLenderIdentity(writeDb, {
      tenantId, actor, input: { ...CONFIRMED, ncrNumber: "NCR99999", ncrNumberConfirm: "NCR99999" },
    })
    expect(result.ok).toBe(false)
    expect(await db.tenantConfig.findUnique({ where: { tenantId } })).toBeNull()
    expect(await auditRows()).toHaveLength(0)
  })

  it("a valid write commits with one audit row, and the resolver reads it back", async () => {
    const result = await updateLenderIdentity(writeDb, { tenantId, actor, input: CONFIRMED })
    expect(result).toMatchObject({ ok: true, changed: true })
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ entity: "TenantConfig", entityId: tenantId, userId: actor.id })
    expect(rows[0].newValue).toMatchObject({ ncrNumber: "NCRCP99999" })
    const identity = await getLenderIdentity(tenantId, db)
    expect(identity).toMatchObject({ ncrNumber: "NCRCP99999", legalName: "Acme Lending (Pty) Ltd" })
  })

  it("a transposed confirmation is rejected and the stored number is unchanged", async () => {
    const result = await updateLenderIdentity(writeDb, {
      tenantId, actor, input: { ...VALID_LENDER_COLUMNS, ncrNumber: "NCRCP99919", ncrNumberConfirm: "NCRCP99199" },
    })
    expect(result.ok).toBe(false)
    expect((await db.tenantConfig.findUnique({ where: { tenantId } }))?.ncrNumber).toBe("NCRCP99999")
    expect(await auditRows()).toHaveLength(1)
  })

  it("each further successful change adds exactly one audit row", async () => {
    const result = await updateLenderIdentity(writeDb, {
      tenantId, actor, input: { ...VALID_LENDER_COLUMNS, ncrNumber: "NCRCP11111", ncrNumberConfirm: "NCRCP11111" },
    })
    expect(result).toMatchObject({ ok: true, changed: true })
    const rows = await auditRows()
    expect(rows).toHaveLength(2)
    expect(rows[1].oldValue).toEqual({ ncrNumber: "NCRCP99999" })
    expect(rows[1].newValue).toEqual({ ncrNumber: "NCRCP11111" })
  })

  // the regulatory details are optional, not typed twice, audited, and
  // stored as DATE columns that read back as the same calendar day.
  const REGULATORY = { ncrRegistrationDate: "2025-10-07", fscaAuthorisationDate: "2026-02-27", ncrStatus: "Registered", headOfficeCity: "Sandton" }
  const CURRENT = { ...VALID_LENDER_COLUMNS, ncrNumber: "NCRCP11111" }

  it("stores the regulatory details as DATE/TEXT with one audit row, and reads them back", async () => {
    const result = await updateLenderIdentity(writeDb, { tenantId, actor, input: { ...CURRENT, ...REGULATORY } })
    expect(result).toMatchObject({ ok: true, changed: true })
    const [raw] = await db.$queryRaw<{ reg: string; fsca: string; status: string; city: string }[]>`
      SELECT "ncrRegistrationDate"::text AS reg, "fscaAuthorisationDate"::text AS fsca, "ncrStatus" AS status, "headOfficeCity" AS city
      FROM "TenantConfig" WHERE "tenantId" = ${tenantId}`
    expect(raw).toEqual({ reg: "2025-10-07", fsca: "2026-02-27", status: "Registered", city: "Sandton" })
    const rows = await auditRows()
    expect(rows).toHaveLength(3)
    expect(rows[2].oldValue).toEqual({ ncrRegistrationDate: null, fscaAuthorisationDate: null, ncrStatus: null, headOfficeCity: null })
    expect(rows[2].newValue).toEqual(REGULATORY)
    expect(await getLenderIdentity(tenantId, db)).toMatchObject(REGULATORY)
  })

  it("an unchanged resubmission of the stored dates writes and audits nothing", async () => {
    const result = await updateLenderIdentity(writeDb, { tenantId, actor, input: { ...CURRENT, ...REGULATORY } })
    expect(result).toMatchObject({ ok: true, changed: false })
    expect(await auditRows()).toHaveLength(3)
  })

  it("a future date is rejected on its field and nothing is persisted", async () => {
    const result = await updateLenderIdentity(writeDb, { tenantId, actor, input: { ...CURRENT, ...REGULATORY, ncrRegistrationDate: "2999-01-01" } })
    expect(result).toMatchObject({ ok: false, errors: { ncrRegistrationDate: expect.any(String) } })
    expect((await getLenderIdentity(tenantId, db)).ncrRegistrationDate).toBe("2025-10-07")
    expect(await auditRows()).toHaveLength(3)
  })

  it("clearing a detail stores NULL and the identity reads it as null", async () => {
    const result = await updateLenderIdentity(writeDb, { tenantId, actor, input: { ...CURRENT, ...REGULATORY, ncrStatus: "" } })
    expect(result).toMatchObject({ ok: true, changed: true })
    expect((await getLenderIdentity(tenantId, db)).ncrStatus).toBeNull()
    expect((await auditRows())[3].newValue).toEqual({ ncrStatus: null })
  })
})
