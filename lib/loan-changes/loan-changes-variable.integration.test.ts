/**
 * A variable-rate or balloon loan through a loan change (real Postgres, real routes): it stays on its reference and keeps its balloon,
 * its rate is not open to change, and the nightly repricing goes on over the terms the change appended, keeping what it carried.
 *
 *   RUN_LOAN_CHANGES_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/loan-changes/loan-changes-variable.integration.test.ts
 *
 * Its own throwaway database: the role needs CREATEDB. Only the session is stood in for.
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"

const holder = vi.hoisted(() => ({ prisma: null as unknown, tenantId: "", user: { id: "", email: "", role: "", totpVerified: true } }))
vi.mock("@/lib/prisma", async (original) => ({
  ...(await original<typeof import("@/lib/prisma")>()),
  prisma: new Proxy({}, { get: (_t, key) => (holder.prisma as Record<string | symbol, unknown>)[key] }),
}))
vi.mock("@/lib/auth-guards", async () => ({
  requireApiRole: vi.fn(async () => ({ error: null, user: holder.user })),
  canDo: (await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions")).canDo,
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) => await runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId })),
}))

import { dbDate } from "@/lib/asset-finance/dates"
import { sastCalendarDate } from "@/lib/date/sast"
import { createAppPrismaClient } from "@/lib/prisma"
import { repriceTenantLoans } from "@/lib/product-engine/reprice-batch"
import { bookLoan, changeRoutes, type LoanFixture } from "./loan-changes.integration-fixture"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const { draftAndSubmit, proposeAndApprove } = changeRoutes(holder)
const day = (offset: number) => sastCalendarDate(new Date(Date.now() + offset * 86_400_000))

suite("loan changes on a variable-rate or balloon loan (real Postgres, real routes)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.prisma = createAppPrismaClient(fresh.url)
  }, 240_000)
  afterAll(() => fresh?.drop())

  /** A version made from a request approved in the database's own terms: the loan is what is under test, not the version's path. */
  async function versionFor(l: LoanFixture) {
    const id = `cr-${randomUUID()}`
    const productId = (await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })).productId
    const eligibility = { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null }
    const config = { minAmountCents: 100_000, maxAmountCents: 100_000_000, minTermDays: 30, maxTermDays: 1_800, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMaxCents: 0, monthlyServiceFeeCents: 5_000, repayment: null, variableRate: null, collateral: [], eligibility }
    const effective = day(0)
    await db().changeRequest.create({ data: { id, tenantId: l.tenantId, kind: "PRODUCT_VERSION", title: "Direct", payload: { productId, effectiveFrom: effective, reason: "Direct write", config } as never, payloadVersion: 1, makerId: l.makerId } })
    await db().changeRequest.update({ where: { id }, data: { status: "SUBMITTED", submittedAt: new Date() } })
    await db().changeRequest.update({ where: { id }, data: { status: "APPROVED", checkerId: l.checkerId, decidedAt: new Date(), appliedAt: new Date() } })
    const version = await db().productVersion.findFirst({ where: { tenantId: l.tenantId, productId } }) ?? await db().productVersion.create({
      data: { tenantId: l.tenantId, productId, version: 1, effectiveFrom: dbDate(effective), minAmount: 100_000, maxAmount: 100_000_000, minTermDays: 30, maxTermDays: 1_800, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 5_000, collateral: [], eligibility, reason: "Direct write", changeRequestId: id },
    })
    return version.id
  }
  const approvedRate = async (l: LoanFixture, effectiveDate: string, rate: string) => {
    const row = await db().referenceRate.create({ data: { tenantId: l.tenantId, basis: "PRIME", effectiveDate: dbDate(effectiveDate), rate, requestedById: l.makerId } })
    await db().referenceRate.update({ where: { id: row.id }, data: { status: "APPROVED", decidedById: l.checkerId, decidedAt: new Date() } })
  }
  /** Terms sequence 1: 4% a month is PRIME 45% + 3%, annual. */
  async function variable(l: LoanFixture, over: { structure?: "AMORTISING" | "BALLOON"; balloonCents?: number } = {}) {
    await db().loanTerms.create({
      data: {
        tenantId: l.tenantId, loanId: l.loanId, sequence: 1, productVersionId: await versionFor(l), frequency: "MONTHLY", structure: over.structure ?? "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 6,
        balloonCents: over.balloonCents ?? 0, baseRatePm: 0.04, interestRatePm: 0.04, rateBasis: "PRIME", rateMarginPa: 0.03, referenceRate: 0.45, referenceEffectiveDate: dbDate(day(-400)),
      },
    })
  }
  const termsOf = (loanId: string) => db().loanTerms.findMany({ where: { loanId }, orderBy: { sequence: "asc" } })
  const rowsOf = (loanId: string) => db().repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })

  it("refuses any proposal that sets the rate: it follows its reference", async () => {
    const l = await bookLoan(db())
    await variable(l)
    for (const payload of [{ type: "RATE_CHANGE", interestRatePm: 0.03 }, { type: "RESTRUCTURE", instalments: 12, interestRatePm: 0.03 }, { type: "REFINANCE", instalments: 12, interestRatePm: 0.03 }]) {
      const { submitted } = await draftAndSubmit(l, payload)
      expect(submitted.status).toBe(422)
      expect(JSON.stringify(await submitted.json())).toContain("follows its reference")
    }
  })

  it("a fixed-rate loan may still have its rate changed", async () => {
    const l = await bookLoan(db())
    expect((await draftAndSubmit(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })).submitted.status).toBe(200)
  })

  it("a change in place keeps the loan on its reference, and the next repricing goes on from the row it appended", async () => {
    const l = await bookLoan(db())
    await variable(l)
    await proposeAndApprove(l, { type: "TERM_CHANGE", instalments: 9 })
    const changed = (await termsOf(l.loanId)).at(-1)!
    expect(changed).toMatchObject({ sequence: 2, rateBasis: "PRIME", rateMarginPa: 0.03, referenceRate: 0.45, instalments: 9 })
    await approvedRate(l, day(-1), "0.33")
    expect(await runWithTenant(l.tenantId, () => repriceTenantLoans(l.tenantId, day(0)))).toMatchObject({ repriced: 1, failed: 0 })
    const after = (await termsOf(l.loanId)).at(-1)!
    expect(after).toMatchObject({ sequence: 3, changeRequestId: null, instalments: 9, referenceRate: 0.33, interestRatePm: 0.03 })
  })

  it("a payment holiday's deferred interest survives a repricing to the cent, and principal reconciles", async () => {
    const l = await bookLoan(db())
    await variable(l)
    await proposeAndApprove(l, { type: "PAYMENT_HOLIDAY", holidayInstalments: 2 })
    const before = await rowsOf(l.loanId)
    await approvedRate(l, day(-1), "0.09")
    await runWithTenant(l.tenantId, () => repriceTenantLoans(l.tenantId, day(0)))
    const after = await rowsOf(l.loanId)
    expect(after.reduce((a, r) => a + r.principalDue, 0)).toBe(before.reduce((a, r) => a + r.principalDue, 0))
    expect(after.every((r) => r.interestDue >= r.carriedInterestDue)).toBe(true)
    expect(after.reduce((a, r) => a + r.carriedInterestDue, 0)).toBe(before.reduce((a, r) => a + r.carriedInterestDue, 0))
    expect(after.reduce((a, r) => a + r.carriedInterestDue, 0)).toBeGreaterThan(0)
  })

  it("a refinance books a new loan still on the reference", async () => {
    const l = await bookLoan(db())
    await variable(l)
    await proposeAndApprove(l, { type: "REFINANCE", instalments: 12 })
    const change = await db().loanChange.findFirstOrThrow({ where: { loanId: l.loanId, type: "REFINANCE" } })
    expect((await termsOf(change.newLoanId!))[0]).toMatchObject({ sequence: 1, rateBasis: "PRIME", rateMarginPa: 0.03, referenceRate: 0.45, interestRatePm: 0.04 })
  })

  it("a balloon loan keeps its balloon through a change: on its terms and on its last row", async () => {
    const l = await bookLoan(db())
    await variable(l, { structure: "BALLOON", balloonCents: 200_000 })
    await proposeAndApprove(l, { type: "TERM_CHANGE", instalments: 6 })
    expect((await termsOf(l.loanId)).at(-1)).toMatchObject({ structure: "BALLOON", balloonCents: 200_000 })
    expect((await rowsOf(l.loanId)).at(-1)!.principalDue).toBeGreaterThan(200_000)
  })

  it("a new loan on a revolving product is held to the limit across the client's revolving products, the loan it settles left out", async () => {
    const l = await bookLoan(db())
    const loan = await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })
    await db().loanProduct.update({ where: { id: loan.productId }, data: { productType: "REVOLVING", maxAmount: 1_000_000 } })
    expect((await draftAndSubmit(l, { type: "REFINANCE", instalments: 12 })).submitted.status).toBe(200)

    const n = randomUUID().slice(0, 8)
    const other = await db().loanProduct.create({ data: { tenantId: l.tenantId, code: `R${n}`, name: "Other line", productType: "REVOLVING", minAmount: 1, maxAmount: 1_000_000, minTermDays: 1, maxTermDays: 720, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE" } })
    const application = await db().loanApplication.create({ data: { tenantId: l.tenantId, reference: `APP-${n}`, clientId: loan.clientId, productId: other.id, appliedAmount: 700_000, appliedTermDays: 90 } })
    await db().loan.create({ data: { tenantId: l.tenantId, reference: `LN-${n}`, applicationId: application.id, clientId: loan.clientId, productId: other.id, principal: 700_000, totalInterest: 0, initiationFee: 0, totalRepayable: 700_000, outstandingPrincipal: 700_000, startDate: new Date(), maturityDate: new Date(), interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", status: "ACTIVE" } })
    const { submitted } = await draftAndSubmit(l, { type: "TOP_UP", instalments: 12, newMoneyCents: 100_000, payoutReference: `REF-${n}` })
    expect(submitted.status).toBe(422)
    expect(JSON.stringify(await submitted.json())).toContain("exceeds the revolving limit")
  })
})
