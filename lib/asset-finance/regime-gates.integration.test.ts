/**
 * Real-Postgres proof of the NCA regime gates (asset finance slice 1, item
 * 4.2): an NCA consumer loan and a NON_NCA entity loan, both 118 days in
 * arrears, side by side in one tenant on the same PERSONAL product.
 *   - the bulk Section 129 run attempts the NCA loan and skips the NON_NCA one
 *     (the tenant has no email configured, so the attempt is refused by the
 *     email layer and recorded as not sent: nothing leaves the machine);
 *   - the consumer bureau population has the consumer loan, never the entity loan;
 *   - charges-sync posts NCA charges for the NCA loan and the product's
 *     NON_NCA arrears terms for the NON_NCA loan.
 *
 *   RUN_ASSET_FINANCE_REGIME_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/regime-gates.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { runWithTenant } from "@/lib/tenant-scope"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ error: null, user: { id: ctx.userId, email: "regime-it@test.invalid", role: "SUPER_ADMIN" } })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
}))

import { prisma } from "@/lib/prisma"
import { POST as bulkSection129 } from "@/app/api/loans/section129/bulk/route"
import { evaluateCollectionsEligibility, SECTION129_NON_NCA_REASON } from "@/lib/collections/section129-eligibility"
import { dailyCandidateIds, monthlyCandidateIds } from "@/lib/bureau-submission/population"
import { syncLoanCharges } from "@/lib/loan/charges-sync"

const suite = process.env.RUN_ASSET_FINANCE_REGIME_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 16)

// R3,000 bullet + R300 interest due 31 May 2026, never paid. Synced on 26 Sep:
// Jun 1..Sep 25 are 117 completed days in default; 118 DPD.
const START = new Date("2026-04-30T10:00:00+02:00")
const DUE = new Date("2026-05-31T10:00:00+02:00")
const AS_OF = new Date("2026-09-26T10:00:00+02:00")

suite.sequential("NCA regime gates (real Postgres)", () => {
  const tenantId = `t_rg_${t}`
  const userId = `u_rg_${t}`
  const productId = `p_rg_${t}`
  const consumerLoanId = `l_rg_nca_${t}`
  const entityLoanId = `l_rg_non_${t}`

  const loanColumns = {
    tenantId, productId, principal: 300_000, totalInterest: 30_000, initiationFee: 0, totalRepayable: 330_000,
    outstandingPrincipal: 300_000, arrearsAmount: 330_000, daysInArrears: 118, startDate: START, maturityDate: DUE,
    interestRatePm: 0.03, interestModel: "FLAT" as const, status: "ACTIVE" as const, monthlyServiceFee: 6_900,
  }
  const scheduleRow = (loanId: string) => ({
    tenantId, loanId, installmentNo: 1, dueDate: DUE, principalDue: 300_000, interestDue: 30_000, feesDue: 0, totalDue: 330_000,
  })

  beforeAll(async () => {
    ctx.tenantId = tenantId
    ctx.userId = userId
    await db.tenant.create({ data: { id: tenantId, slug: `rg-${t}`, name: "Regime gates IT" } })
    await db.tenantConfig.create({
      data: {
        ...VALID_LENDER_COLUMNS, tenantId,
        defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2026-01-01T00:00:00+02:00"),
      },
    })
    await db.user.create({ data: { id: userId, tenantId, email: `${t}@test.invalid`, password: "x", role: "SUPER_ADMIN" } })
    // One product for both: the bureau's product filter cannot be what excludes the entity loan.
    await db.loanProduct.create({
      data: {
        id: productId, tenantId, code: `RG-${t}`, name: "Regime gates", productType: "PERSONAL",
        minAmount: 1, maxAmount: 100_000_000, minTermDays: 1, maxTermDays: 3_650, interestRatePm: 0.03,
        interestModel: "FLAT", monthlyServiceFee: 6_900, nonNcaDefaultInterestMargin: "0.04", nonNcaCollectionFeeCents: 15_000,
      },
    })

    // NCA consumer loan (application left in DRAFT, as the charges fixtures book it).
    const clientId = `c_rg_${t}`
    await db.client.create({
      data: { id: clientId, tenantId, idNumber: `RG${t}`, firstName: "Test", lastName: "Consumer", email: `c-${t}@client.invalid`, phone: "0820000000" },
    })
    const consumerApp = await db.loanApplication.create({
      data: { tenantId, reference: `APP-RG-C-${t}`, clientId, productId, appliedAmount: 300_000, appliedTermDays: 31 },
    })
    await db.loan.create({ data: { ...loanColumns, id: consumerLoanId, reference: `LN-RG-C-${t}`, applicationId: consumerApp.id, clientId } })
    await db.repaymentSchedule.create({ data: scheduleRow(consumerLoanId) })

    // NON_NCA entity loan: classified, approved, then booked and disbursed together.
    const entityId = `e_rg_${t}`
    await db.businessEntity.create({
      data: { id: entityId, tenantId, type: "COMPANY", legalName: "TEST Plant Hire (Pty) Ltd", registrationNumber: `2099/${t.slice(0, 6)}/07` },
    })
    const entityApp = await db.loanApplication.create({
      data: {
        tenantId, reference: `APP-RG-E-${t}`, entityId, productId, appliedAmount: 300_000, appliedTermDays: 31,
        ncaRegime: "NON_NCA", ncaClassificationRule: "TEST_RULE", ncaClassifiedAt: new Date(), ncaClassifiedById: userId,
      },
    })
    await db.loanApplication.update({ where: { id: entityApp.id }, data: { status: "SUBMITTED" } })
    await db.loanApplication.update({
      where: { id: entityApp.id },
      data: { status: "APPROVED", repaymentMethod: "EFT", approvedAt: new Date(), approvedById: userId },
    })
    await db.$transaction(async (tx) => {
      await tx.loan.create({
        data: {
          ...loanColumns, id: entityLoanId, reference: `LN-RG-E-${t}`, applicationId: entityApp.id, entityId,
          ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE",
        },
      })
      await tx.loanApplication.update({ where: { id: entityApp.id }, data: { status: "DISBURSED", disbursedAt: new Date() } })
    })
    await db.repaymentSchedule.create({ data: scheduleRow(entityLoanId) })
  })

  afterAll(async () => {
    const where = { tenantId }
    await db.auditLog.deleteMany({ where })
    await db.complianceRecord.deleteMany({ where })
    await db.loanCharge.deleteMany({ where })
    await db.repaymentSchedule.deleteMany({ where })
    // Together: a disbursed application and its loan must commit as a pair.
    await db.$transaction([db.loan.deleteMany({ where }), db.loanApplication.deleteMany({ where })])
    await db.businessEntity.deleteMany({ where })
    await db.client.deleteMany({ where })
    await db.loanProduct.deleteMany({ where })
    await db.user.deleteMany({ where })
    await db.tenantConfig.deleteMany({ where })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("stores the regimes the gates key on", async () => {
    const loans = await db.loan.findMany({ where: { tenantId }, select: { id: true, ncaRegime: true, entityId: true } })
    expect(Object.fromEntries(loans.map((l) => [l.id, l.ncaRegime]))).toEqual({ [consumerLoanId]: "NCA", [entityLoanId]: "NON_NCA" })
  })

  it("the bulk Section 129 run picks the NCA loan and skips the NON_NCA loan, refused on its regime", async () => {
    const response = await bulkSection129(new NextRequest("http://localhost/api/loans/section129/bulk", { method: "POST" }))
    const body = await response.json() as { skipped: number; results: Array<{ loanId: string; error?: string }> }
    // Only the NCA loan was taken up (and refused by the unconfigured email layer).
    expect(body.results.map((result) => result.loanId)).toEqual([consumerLoanId])
    expect(body.results[0].error).toContain("Email not configured")
    expect(body.skipped).toBe(1)

    const row = await db.loan.findUniqueOrThrow({
      where: { id: entityLoanId },
      select: { status: true, ncaRegime: true, arrearsAmount: true, outstandingPrincipal: true, daysInArrears: true },
    })
    expect(evaluateCollectionsEligibility(row, "SECTION_129")).toMatchObject({ eligible: false, reason: SECTION129_NON_NCA_REASON })
    expect(evaluateCollectionsEligibility(row, "DUNNING").eligible).toBe(true)
  })

  it("the consumer bureau population has the consumer loan and never the entity loan", async () => {
    const monthly = await runWithTenant(tenantId, () => monthlyCandidateIds(prisma, {
      // Even when the ledger claims the bureau knows the entity loan.
      tenantId, periodDay: "2026-08-31", reportingStartDay: "2026-01-01", knownLoanIds: [entityLoanId],
    }))
    expect(monthly).toEqual([consumerLoanId])
    const daily = await runWithTenant(tenantId, () => dailyCandidateIds(prisma, {
      tenantId, day: "2026-04-30", reportingStartDay: "2026-01-01", knownLoanIds: [entityLoanId],
    }))
    expect(daily.registrations).toEqual([consumerLoanId])
  })

  async function syncAndRead(loanId: string) {
    await runWithTenant(tenantId, () => prisma.$transaction((tx) => syncLoanCharges(tx, { tenantId, loanId }, AS_OF, { source: "regime-gates-it" })))
    const charges = await db.loanCharge.findMany({ where: { loanId }, orderBy: [{ day: "asc" }, { type: "asc" }] })
    return charges.map((c) => [c.type, c.day.toISOString().slice(0, 10), c.amount])
  }

  it("charges-sync posts NCA default charges on the NCA loan, as before", async () => {
    // 3% a month on R3,000 overdue principal = R90 a month (R75 for Sep 1..25),
    // and the post-maturity service fee on the 1st while in default.
    expect(await syncAndRead(consumerLoanId)).toEqual([
      ["DEFAULT_INTEREST", "2026-06-30", 9_000],
      ["SERVICE_FEE", "2026-07-01", 6_900],
      ["DEFAULT_INTEREST", "2026-07-31", 9_000],
      ["SERVICE_FEE", "2026-08-01", 6_900],
      ["DEFAULT_INTEREST", "2026-08-31", 9_000],
      ["SERVICE_FEE", "2026-09-01", 6_900],
      ["DEFAULT_INTEREST", "2026-09-25", 7_500],
    ])
    expect(await db.loan.findUniqueOrThrow({ where: { id: consumerLoanId } })).toMatchObject({ chargesAccrued: 55_200, daysInArrears: 118 })
  })

  it("charges-sync posts the product's NON_NCA terms on the NON_NCA loan: no service fee, no cap", async () => {
    // (36% + 4%) / 365 on R3,300 overdue (principal + contractual interest):
    // cumulative 30, 61, 92 and 117 days = 10849.32, 22060.27, 33271.23,
    // 42312.33, posted as month-end differences; R150 collection fee on Jun 1.
    expect(await syncAndRead(entityLoanId)).toEqual([
      ["COLLECTION_FEE", "2026-06-01", 15_000],
      ["DEFAULT_INTEREST", "2026-06-30", 10_849],
      ["DEFAULT_INTEREST", "2026-07-31", 11_211],
      ["DEFAULT_INTEREST", "2026-08-31", 11_211],
      ["DEFAULT_INTEREST", "2026-09-25", 9_041],
    ])
    expect(await db.loan.findUniqueOrThrow({ where: { id: entityLoanId } })).toMatchObject({
      chargesAccrued: 57_312, chargesOutstanding: 57_312, daysInArrears: 118,
    })
  })
})
