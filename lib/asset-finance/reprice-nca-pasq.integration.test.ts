/** Exact NCA PASQ monetary model with real migrated guards. The origination
 * snapshot is installed as a fixture; repricing never disables a trigger.
 */
import { createCreditLifeDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { CREDIT_LIFE_DISCLOSURE_VERSION } from "@/lib/insurance/credit-life-election"
import { Prisma, PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { affordabilityCalculatorFingerprint, affordabilityContractFingerprint } from "@/lib/affordability/snapshot"
import { createPasqEvidence, pasqEvidenceIsIntact } from "@/lib/compliance/pasq"
import { assetCalculatorEvidence } from "./nca-evidence"
import { repriceLoanForReference } from "./reprice-loan"
import { BOOKED, DEAL, PAID_ROWS, approvedPrime, createRepriceLoan, createRepriceTenant } from "./reprice.integration-fixture"
import { dbDate, isoOfDbDate } from "./dates"

import { NextRequest } from "next/server"
import { runWithTenant } from "@/lib/tenant-scope"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { currentSettlementAmount } from "@/lib/loan/settlement"
import { PATCH as reversePayment } from "@/app/api/payments/[id]/reverse/route"
const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ error: null, user: { id: ctx.userId, role: "SUPER_ADMIN" } })) }))
vi.mock("@/lib/tenant", async (original) => ({ ...(await original<typeof import("@/lib/tenant")>()), withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) => runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })) }))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn() }))
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
suite("NCA repricing on an acknowledged PASQ with fees and premiums", () => {
  afterAll(async () => { vi.useRealTimers(); await db.$disconnect() })
  it("reprices the real billing model without capitalising or dropping its fees/premiums, preserving the original PASQ", async () => {
    const tenant = await createRepriceTenant(db)
    const loanId = await createRepriceLoan(db, tenant)
    const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId } })
    const service = 6_900, initiation = 120_750, premium = 4_500
    const bare = assetCalculatorEvidence({ ok: true, result: BOOKED, startDate: DEAL.startDate, termDays: 1800 } as never, 0)
    const { pricingFingerprint: _pricing, contractFingerprint: _contract, ...base } = bare
    const schedule = base.schedule.map((row, i) => ({ ...row, feesDueCents: service + (i === 0 ? initiation : 0), totalDueCents: row.totalDueCents + service + (i === 0 ? initiation : 0) }))
    const calc = { ...base, initiationFeeCents: initiation, serviceFeesCents: service * schedule.length,
      recurringInstalmentCents: BOOKED.baseInstalmentCents + service,
      totalRepayableCents: schedule.reduce((sum, row) => sum + row.totalDueCents, 0), schedule }
    const calculator = { ...calc, pricingFingerprint: affordabilityCalculatorFingerprint(calc), contractFingerprint: affordabilityContractFingerprint(calc) }
    const evidence = createPasqEvidence({ tenantId: tenant.tenantId, applicationId: loan.applicationId, clientId: tenant.directorId,
      productId: tenant.productId, termDays: 1800, generatedAt: new Date("2026-01-15T08:00:00Z"), calculator,
      creditLife: { election: "ACCEPTED", productId: "synthetic-rate-cover", productName: "Synthetic cover", insurerId: "synthetic-rate-insurer", insurerName: "Synthetic insurer", monthlyPremiumCents: premium, disclosureVersion: CREDIT_LIFE_DISCLOSURE_VERSION, disclosureSha256: createCreditLifeDisclosureSha256({ version: CREDIT_LIFE_DISCLOSURE_VERSION, election: "ACCEPTED", principalCents: calculator.principalCents, termDays: 1800, monthlyPremiumCents: premium, productId: "synthetic-rate-cover", productName: "Synthetic cover", insurerId: "synthetic-rate-insurer", insurerName: "Synthetic insurer" }) },
    })
    expect(pasqEvidenceIsIntact(evidence)).toBe(true)
    // Fixture setup only: install a signed asset PASQ and its booked monetary
    // rows. Real guards are active for every operation exercised below.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      await tx.loanApplication.update({ where: { id: loan.applicationId }, data: { ncaRegime: "NCA", ncaRepresentativeClientId: tenant.directorId, pasqVersion: "pasq-v3", pasqEvidence: evidence as unknown as Prisma.InputJsonValue, pasqEvidenceSha256: evidence.evidenceSha256,
        pasqGeneratedAt: new Date("2026-01-15T08:00:00Z"), pasqDocumentId: `synthetic-rate-pasq-${loanId}`, pasqDocumentSha256: "a".repeat(64),
        pasqAcknowledgedAt: new Date("2026-01-15T09:00:00Z"), pasqAcknowledgedBy: tenant.directorId, pasqAcknowledgedSha256: "a".repeat(64),
        creditLifeElection: "DECLINED", creditLifeMonthlyPremiumCents: 0, creditLifeDisclosureVersion: "credit-life-no-offer-v1", creditLifeDisclosureSha256: "a".repeat(64), creditLifeDisclosureAcknowledgedAt: new Date(), creditLifeDisclosureAcknowledgedBy: tenant.directorId } })
      await tx.loan.update({ where: { id: loanId }, data: { ncaRegime: "NCA", monthlyServiceFee: service, initiationFee: initiation,
        creditLifePremiums: evidence.creditLife.totalPremiumCents, totalRepayable: evidence.billing.totalRepayableCents, contractualTotalRepayable: evidence.billing.totalRepayableCents,
        totalPaid: evidence.billing.schedule.slice(0, PAID_ROWS).reduce((sum, row) => sum + row.totalDueCents, 0) } })
      const rows = await tx.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
      for (let i = 0; i < rows.length; i++) {
        const row = evidence.billing.schedule[i]
        await tx.repaymentSchedule.update({ where: { id: rows[i].id }, data: { feesDue: row.feesDueCents, creditLifePremiumDue: row.creditLifePremiumDueCents, totalDue: row.totalDueCents, totalPaid: i < PAID_ROWS ? row.totalDueCents : 0 } })
      }
      for (let i = 0; i < PAID_ROWS; i++) {
        await tx.payment.create({ data: { tenantId: tenant.tenantId, loanId, amount: evidence.billing.schedule[i].totalDueCents, receivedAt: rows[i].dueDate, capturedBy: tenant.adminId } })
      }
      const firstRate = await tx.contractRate.findFirstOrThrow({ where: { loanId } })
      await tx.contractRate.update({ where: { id: firstRate.id }, data: { newInstalmentCents: BOOKED.baseInstalmentCents + service } })
    })
    const repo = await db.referenceRate.create({ data: { tenantId: tenant.tenantId, basis: "REPO", effectiveDate: dbDate(DEAL.startDate), rate: "0.08", requestedById: tenant.adminId } })
    await db.referenceRate.update({ where: { id: repo.id }, data: { status: "APPROVED", decidedById: tenant.approverId, decidedAt: new Date() } })
    const effectiveDate = BOOKED.rows[9].dueDate
    await approvedPrime(db, tenant, effectiveDate, "0.10")
    const before = await db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
    const outcome = await prisma.$transaction((tx) => repriceLoanForReference(tx, { tenantId: tenant.tenantId, loanId, basis: "PRIME", effectiveDate, runDate: BOOKED.rows[PAID_ROWS - 1].dueDate }))
    expect(outcome).toMatchObject({ kind: "repriced", resultingRate: "0.11" })
    const after = await db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
    expect(after.map((row) => [row.feesDue, row.creditLifePremiumDue])).toEqual(before.map((row) => [row.feesDue, row.creditLifePremiumDue]))
    expect(after.slice(0, PAID_ROWS).map((row) => [row.totalDue, row.totalPaid, row.paidAt, row.status])).toEqual(before.slice(0, PAID_ROWS).map((row) => [row.totalDue, row.totalPaid, row.paidAt, row.status]))
    expect(after[10].interestDue).toBeLessThan(before[10].interestDue)
    const changed = await db.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(changed.principal).toBe(evidence.calculator.principalCents)
    expect(changed.totalInterest).toBe(after.reduce((sum, row) => sum + row.interestDue, 0))
    expect(changed.totalRepayable).toBe(after.reduce((sum, row) => sum + row.totalDue, 0))
    expect(changed.outstandingPrincipal).toBe(after.slice(PAID_ROWS).reduce((sum, row) => sum + row.principalDue, 0))
    // The asset-only exemption does not authorize an arbitrary monetary edit.
    await expect(db.$transaction(async (tx) => {
      await tx.repaymentSchedule.update({ where: { id: after[15].id }, data: { interestDue: { increment: 1 }, totalDue: { increment: 1 } } })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })).rejects.toThrow()
    await expect(db.$transaction(async (tx) => {
      await tx.loan.update({ where: { id: loanId }, data: { totalInterest: { increment: 1 }, totalRepayable: { increment: 1 } } })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })).rejects.toThrow()
    expect((await db.loanApplication.findUniqueOrThrow({ where: { id: loan.applicationId } })).pasqEvidence).toEqual(evidence)
    // Actual receipt and HTTP reversal paths must consume the revised contract.
    const settleDay = new Date(BOOKED.rows[PAID_ROWS].dueDate + "T10:00:00+02:00")
    vi.useFakeTimers({ toFake: ["Date"], now: settleDay })
    const settlement = currentSettlementAmount({ loan: changed, schedule: after, asOf: settleDay })
    const receipt = await runWithTenant(tenant.tenantId, () => applyManualReceipt(prisma, { tenantId: tenant.tenantId, loanId, amount: settlement, capturedById: tenant.adminId }))
    expect((await db.loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe("COMPLETED")
    ctx.tenantId = tenant.tenantId; ctx.userId = tenant.adminId
    const response = await reversePayment(new NextRequest("http://localhost/api/payments/synthetic/reverse", { method: "PATCH", body: JSON.stringify({ reason: "Synthetic bank return" }) }), { params: Promise.resolve({ id: receipt.payment.id }) })
    expect(response.status).toBe(200)
    const restored = await db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
    expect(restored.map((row) => [row.principalDue, row.interestDue, row.feesDue, row.creditLifePremiumDue, row.totalDue])).toEqual(after.map((row) => [row.principalDue, row.interestDue, row.feesDue, row.creditLifePremiumDue, row.totalDue]))
    expect(isoOfDbDate((await db.contractRate.findFirstOrThrow({ where: { loanId }, orderBy: { effectiveDate: "desc" } })).effectiveDate)).toBe(effectiveDate)
  })
})
