/**
 * The mandate guard takes a rate off the product row as a variable rate only outside the NCA (real Postgres, the real decide path, an NCA
 * instance). The code refuses a variable version to an NCA lender; that refusal is stood down here, so the database is all that stands.
 *
 *   RUN_APPROVAL_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/product-types/variable-nca.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", async (importOriginal) => (await import("@/lib/approval/approval.integration-prisma")).mockPrisma(await importOriginal<typeof import("@/lib/prisma")>()))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))
vi.mock("@/lib/product-engine/nca", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/product-engine/nca")>()), versionNcaIssues: vi.fn(async () => []) }))

import { dbDate } from "@/lib/asset-finance/dates"
import { A, TODAY, approveAs, as, db, ids, registerApprovalFixture, statusOf, suite, underReview } from "@/lib/approval/approval.integration-fixture"

/** A variable version in effect on the fixture's product, its request approved in the database's own terms: the parser would refuse it to an NCA lender. */
async function variableVersion() {
  const id = `cr-${randomUUID()}`
  const eligibility = { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null }
  const repayment = { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 } as const
  const config = { minAmountCents: 1, maxAmountCents: 100_000_000, minTermDays: 1, maxTermDays: 720, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMaxCents: 0, monthlyServiceFeeCents: 6_900, repayment, variableRate: { basis: "PRIME", marginPa: 0.03 }, collateral: [], eligibility }
  await db.changeRequest.create({ data: { id, tenantId: ids.tenant, kind: "PRODUCT_VERSION", title: "Direct", payload: { productId: ids.product, effectiveFrom: TODAY, reason: "Direct write", config } as never, payloadVersion: 1, makerId: as.maker.id } })
  await db.changeRequest.update({ where: { id }, data: { status: "SUBMITTED", submittedAt: new Date() } })
  await db.changeRequest.update({ where: { id }, data: { status: "APPROVED", checkerId: as.checker.id, decidedAt: new Date(), appliedAt: new Date() } })
  await db.productVersion.create({
    data: {
      tenantId: ids.tenant, productId: ids.product, version: 1, effectiveFrom: dbDate(TODAY), minAmount: 1, maxAmount: 100_000_000, minTermDays: 1, maxTermDays: 720, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900, frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", rateBasis: "PRIME", rateMarginPa: 0.03, collateral: [], eligibility, reason: "Direct write", changeRequestId: id,
    },
  })
  await db.loanProduct.update({ where: { id: ids.product }, data: { minAmount: 1, maxAmount: 100_000_000, minTermDays: 1, maxTermDays: 720, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900 } })
  const rate = await db.referenceRate.create({ data: { tenantId: ids.tenant, basis: "PRIME", effectiveDate: dbDate(TODAY), rate: "0.09", requestedById: as.maker.id } })
  await db.referenceRate.update({ where: { id: rate.id }, data: { status: "APPROVED", decidedById: as.checker.id, decidedAt: new Date() } })
}

suite("a variable rate on an NCA application (real Postgres)", () => {
  registerApprovalFixture()

  it("is refused by the database, even with the code's refusal stood down", async () => {
    await variableVersion()
    const id = A("nca-variable")
    await underReview(id, { amount: 300_000 })
    await db.applicationPricingInput.upsert({ where: { applicationId: id }, create: { applicationId: id, tenantId: ids.tenant, channel: "BRANCH" }, update: { channel: "BRANCH" } })
    await expect(approveAs("la1", id)).rejects.toThrow("validated approval transition")
    expect(await statusOf(id)).toBe("UNDER_REVIEW")
  })
})
