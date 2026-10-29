/**
 * Real-Postgres proof of the jurisdiction guards (migration
 * 20261029100000_jurisdiction_guards): the currency CHECK refuses ZA + LSL, and
 * a lender's jurisdiction is frozen once it has a loan application or loan,
 * also under a strict row-level-security session with no tenant frame.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/jurisdiction/guards.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it } from "vitest"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()

suite("jurisdiction guards (real DB)", () => {
  afterAll(() => db.$disconnect())

  it("refuses a ZA lender billed in loti, and accepts LS in loti or rand", async () => {
    const t = await createChargesTenant(db, false)
    await expect(db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { currency: "LSL" } })).rejects.toThrow(/jurisdiction_currency/)
    await db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { jurisdiction: "LS", currency: "LSL" } })
    await db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { currency: "ZAR" } })
    await expect(db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { jurisdiction: "ZA", currency: "LSL" } })).rejects.toThrow()
  })

  it("lets an operator change the jurisdiction of a lender with no applications or loans", async () => {
    const t = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { jurisdiction: "LS", currency: "LSL" } })
    const row = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } })
    expect(row.jurisdiction).toBe("LS")
  })

  it("refuses a jurisdiction change once the lender has a loan or application", async () => {
    const t = await createChargesTenant(db, false)
    await createChargesLoan(db, t)
    await expect(db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { jurisdiction: "LS", currency: "LSL" } }))
      .rejects.toThrow(/cannot change once it has loan applications or loans/)
    // Unrelated edits to the row are still fine.
    await db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { primaryColor: "#112233" } })
  })

  it("still refuses when row-level security would show the guard no rows", async () => {
    const t = await createChargesTenant(db, false)
    await createChargesLoan(db, t)
    await expect(db.$transaction(async (tx) => {
      // A frame for another tenant: without the guard's own bypass its lookups would see nothing.
      await tx.$executeRaw`SELECT set_config('app.tenant_id', 'some-other-tenant', true)`
      await tx.$executeRawUnsafe(`UPDATE "TenantConfig" SET "jurisdiction" = 'LS', "currency" = 'LSL' WHERE "tenantId" = '${t.tenantId}'`)
    })).rejects.toThrow(/cannot change/)
  })
})
