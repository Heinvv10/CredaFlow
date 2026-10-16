/**
 * Real-Postgres proof that a lender with no FSP number has no credit-life
 * offer (#143 blind review, HIGH), even with an active credit-life product and
 * insurer: the lookup every offer path uses (creditLifeOfferFindFirstArgs —
 * portal and staff apply, prepare-application, PASQ, decide, asset-finance
 * election) finds none, so the application records the no-offer state.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/insurance/credit-life-no-fsp.integration.test.ts
 */
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { creditLifeOfferFindFirstArgs } from "./credit-life-offer"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const tenants: string[] = []

async function lender(fscaNumber: string | null): Promise<string> {
  const token = randomBytes(6).toString("hex")
  const tenant = await db.tenant.create({ data: { slug: `cl-fsp-it-${token}`, name: "Credit Life FSP IT", status: "ACTIVE" } })
  tenants.push(tenant.id)
  await db.tenantConfig.create({ data: { tenantId: tenant.id, fscaNumber } })
  const insurer = await db.insurer.create({ data: { tenantId: tenant.id, name: `Synthetic Underwriter ${token}` } })
  await db.insuranceProduct.create({
    data: {
      tenantId: tenant.id, code: `CL-${token}`, name: "Synthetic Credit Life", type: "CREDIT_LIFE",
      premiumAmount: "1.50", sumAssured: "1000.00", insurerId: insurer.id, active: true,
    },
  })
  return tenant.id
}

suite("credit-life offer and the lender's FSP number", () => {
  let withFsp = ""
  let withoutFsp = ""
  beforeAll(async () => {
    withFsp = await lender("12345")
    withoutFsp = await lender(null)
  })
  afterAll(async () => {
    const tenantId = { in: tenants }
    await db.insuranceProduct.deleteMany({ where: { tenantId } })
    await db.insurer.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("offers the active product to a lender that holds an FSP number", async () => {
    expect(await db.insuranceProduct.findFirst(creditLifeOfferFindFirstArgs(withFsp))).toMatchObject({ name: "Synthetic Credit Life" })
  })

  it("offers nothing to a lender without one, though the product is active", async () => {
    expect(await db.insuranceProduct.findFirst(creditLifeOfferFindFirstArgs(withoutFsp))).toBeNull()
  })
})
