/**
 * Real-Postgres proof of the NCA s125 early settlement of an instalment loan:
 * the receipt path closes the loan at the s125 figure and re-prices the rows
 * (lib/loan/s125-settlement.ts, lib/loan/settlement.ts); the database accepts
 * that only with the settlement's audit evidence (migration
 * 20261016200000_s125_instalment_settlement); a reversal restores the
 * contractual rows exactly, for a PASQ v3 loan and for one booked without a
 * PASQ; the book as at an earlier date is rebuilt on the contract; and no
 * interest income is posted after the settlement date.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/s125-settlement.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"

const { ctx } = vi.hoisted(() => ({ ctx: { tenantId: "", userId: "" } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({
    error: null,
    user: { id: ctx.userId, email: "s125-it@test.invalid", role: "SUPER_ADMIN" },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await runWithTenant(ctx.tenantId, () => handler({ id: ctx.tenantId })),
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: vi.fn(async () => undefined) }))

import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { currentSettlementAmount } from "@/lib/loan/settlement"
import { bookLoan, createApprovedPasqV3Application, type PasqV3Scenario } from "@/lib/compliance/pasq-v3-application.integration-fixture"
import { createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { PATCH as reversePayment } from "@/app/api/payments/[id]/reverse/route"
import { loadBookAsOf } from "@/lib/reports/book-as-of"
import { loadSourceLoans } from "@/lib/accounting/store"
import { loanSources } from "@/lib/accounting/sources"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
// Unscoped reads: the tenant-scoped client refuses a read with no tenant context.
const db = new PrismaClient()

const at = (iso: string) => new Date(`${iso}T10:00:00+02:00`)
const MONEY = ["installmentNo", "principalDue", "interestDue", "feesDue", "creditLifePremiumDue", "totalDue"] as const
type Row = Record<(typeof MONEY)[number], number>
const money = (rows: Row[]) => rows.map((row) => Object.fromEntries(MONEY.map((k) => [k, row[k]])))

async function loanWithRows(loanId: string) {
  return db.loan.findUniqueOrThrow({
    where: { id: loanId },
    include: { repaymentSchedule: { orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }] } },
  })
}

/** Captures a receipt as staff do, on the day it is received. */
async function capture(tenantId: string, userId: string, loanId: string, amount: number, day: string) {
  vi.setSystemTime(at(day))
  return runWithTenant(tenantId, () => applyManualReceipt(prisma, { tenantId, loanId, amount, capturedById: userId }))
}

async function reverse(tenantId: string, userId: string, paymentId: string) {
  ctx.tenantId = tenantId
  ctx.userId = userId
  const res = await reversePayment(
    new NextRequest(`http://localhost/api/payments/${paymentId}/reverse`, { method: "PATCH", body: JSON.stringify({ reason: "Bank returned the EFT (IT)." }) }),
    { params: Promise.resolve({ id: paymentId }) },
  )
  expect(res.status).toBe(200)
}

suite.sequential("NCA s125 early settlement of an instalment loan (real Postgres)", () => {
  let scenario: PasqV3Scenario
  let loanId = ""
  let contractual: Row[] = []
  let principalBefore = 0
  let settlement = 0
  let settlementPaymentId = ""

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-07-24") })
    // R10,000 over six months at 2% a month reducing, a deferred initiation fee,
    // R69 service fee and R22.50 credit-life premium per instalment.
    scenario = await createApprovedPasqV3Application("s125", "ACCEPTED", true, "DEFERRED", false, null, {
      pricing: {
        principal: 1_000_000, termDays: 180, productType: "PERSONAL", interestRatePm: 0.02, interestModel: "REDUCING_BALANCE",
        initiationFeeModel: "NCA_REG42", initiationFeePct: 0.15, initiationFeeMax: 105_000, monthlyServiceFee: 6_900,
        initiationFeePayment: "DEFERRED",
      },
    })
    loanId = await bookLoan(scenario)
    const booked = await loanWithRows(loanId)
    const [first, second, third] = booked.repaymentSchedule
    // Instalments 1 and 2 on their due dates, and half of instalment 3 early.
    await capture(scenario.tenantId, scenario.officerId, loanId, first.totalDue, first.dueDate.toISOString().slice(0, 10))
    await capture(scenario.tenantId, scenario.officerId, loanId, second.totalDue, second.dueDate.toISOString().slice(0, 10))
    await capture(scenario.tenantId, scenario.officerId, loanId, Math.round(third.totalDue / 2), "2026-10-05")
    vi.setSystemTime(at("2026-10-10"))
    const before = await loanWithRows(loanId)
    contractual = before.repaymentSchedule as unknown as Row[]
    principalBefore = before.outstandingPrincipal
    settlement = currentSettlementAmount({ loan: before, schedule: before.repaymentSchedule, asOf: at("2026-10-10") })
    const { payment } = await capture(scenario.tenantId, scenario.officerId, loanId, settlement, "2026-10-10")
    settlementPaymentId = payment.id
  }, 120_000)
  afterAll(async () => {
    vi.useRealTimers()
  })

  it("closes the loan at the s125 figure, below the contractual balance", async () => {
    const after = await loanWithRows(loanId)
    const contractualRemaining = scenario.pasqEvidence.billing.totalRepayableCents - (after.totalPaid - settlement)
    expect(settlement).toBeLessThan(contractualRemaining)
    expect(after).toMatchObject({
      status: "COMPLETED", outstandingPrincipal: 0,
      contractualTotalRepayable: scenario.pasqEvidence.billing.totalRepayableCents,
      contractualTotalInterest: scenario.pasqEvidence.calculator.totalInterestCents,
    })
    expect(after.totalRepayable).toBe(after.totalPaid)
    // Instalments 1–2 unchanged; 3 is the current period (24 Sep – 24 Oct):
    // principal and 16 of 30 days' interest; 4–6 principal only.
    const [first, second, third, ...later] = after.repaymentSchedule
    expect(money([first, second] as unknown as Row[])).toEqual(money(contractual.slice(0, 2)))
    expect(third.interestDue).toBe(Math.round((contractual[2].interestDue * 16) / 30))
    expect(third).toMatchObject({ feesDue: 0, creditLifePremiumDue: 0, status: "PAID" })
    for (const row of later) expect(row).toMatchObject({ interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: row.principalDue })
    // The premium total booked with the loan is unchanged; what was charged of it is less.
    expect(after.creditLifePremiums).toBe(scenario.pasqEvidence.creditLife.totalPremiumCents)
  })

  it("rebuilds the book as at before the settlement on the contractual rows", async () => {
    // Half of instalment 3 was paid early: on the contract that is interest
    // and fees first, so less principal than on the re-priced row.
    expect(await loadBookAsOf(prisma, scenario.tenantId, at("2026-10-09"))).toBe(principalBefore)
  })

  it("posts no interest income after the settlement date", async () => {
    const [source] = (await loadSourceLoans(prisma, scenario.tenantId, at("2027-06-01"))).filter((loan) => loan.id === loanId)
    const sources = loanSources(source, at("2027-06-01"))
    const income = (when: (date: Date) => boolean) => 0 - sources
      .filter((s) => s.origin.date && when(s.origin.date))
      .reduce((sum, s) => sum + (s.vector.INTEREST_INCOME ?? 0), 0) + 0
    const settled = await db.loan.findUniqueOrThrow({ where: { id: loanId } })
    expect(income((date) => date.getTime() > settled.closedAt!.getTime())).toBe(0)
    expect(income(() => true)).toBe(settled.totalInterest)
    expect(settled.totalInterest).toBeLessThan(scenario.pasqEvidence.calculator.totalInterestCents)
  })

  it("refuses a re-priced schedule the settlement's audit evidence does not cover", async () => {
    const other = await createApprovedPasqV3Application("s125-unaudited", "ACCEPTED", true, "DEFERRED", false, null, { pricing: scenario.pricing })
    const otherLoanId = await bookLoan(other)
    const rows = (await loanWithRows(otherLoanId)).repaymentSchedule
    const repriced = rows.map((row, i) => (i === 0 ? row : { ...row, interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: row.principalDue }))
    const total = repriced.reduce((sum, row) => sum + row.totalDue, 0)
    await expect(db.$transaction(async (tx) => {
      await tx.payment.create({ data: { tenantId: other.tenantId, loanId: otherLoanId, amount: total, paymentMethod: "EFT", capturedBy: other.officerId } })
      for (const row of repriced) {
        await tx.repaymentSchedule.update({
          where: { id: row.id },
          data: { interestDue: row.interestDue, feesDue: row.feesDue, creditLifePremiumDue: row.creditLifePremiumDue, totalDue: row.totalDue, totalPaid: row.totalDue, status: "PAID", paidAt: at("2026-08-01") },
        })
      }
      await tx.loan.update({
        where: { id: otherLoanId },
        data: {
          totalInterest: repriced.reduce((sum, row) => sum + row.interestDue, 0), totalRepayable: total, totalPaid: total,
          outstandingPrincipal: 0, status: "COMPLETED", closedAt: at("2026-08-01"),
        },
      })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })).rejects.toThrow(/Early instalment settlement does not preserve PASQ v3 contractual and ledger evidence/)
  })

  it("restores the contractual rows exactly when the settlement receipt is reversed", async () => {
    await reverse(scenario.tenantId, scenario.officerId, settlementPaymentId)
    const reopened = await loanWithRows(loanId)
    expect(money(reopened.repaymentSchedule as unknown as Row[])).toEqual(money(contractual))
    expect(reopened).toMatchObject({
      status: "ACTIVE",
      totalRepayable: scenario.pasqEvidence.billing.totalRepayableCents,
      totalInterest: scenario.pasqEvidence.calculator.totalInterestCents,
      outstandingPrincipal: principalBefore,
    })
  })
})

suite.sequential("NCA s125 early settlement of a loan booked without a PASQ (real Postgres)", () => {
  it("settles and restores from the settlement's own audit evidence", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-06-01") })
    const tenant = await createChargesTenant(db, false)
    const n = randomUUID().replaceAll("-", "").slice(0, 12)
    const client = await db.client.create({
      data: { tenantId: tenant.tenantId, idNumber: `91${n.slice(0, 11)}`, firstName: "Legacy", lastName: "Loan", email: `${n}@client.invalid`, phone: "0820000000" },
    })
    const app = await db.loanApplication.create({
      data: { tenantId: tenant.tenantId, reference: `APP-${n}`, clientId: client.id, productId: tenant.productId, appliedAmount: 300_000, appliedTermDays: 90 },
    })
    // Three R1,000 instalments with R50 interest and a R69 fee each.
    const loan = await db.loan.create({
      data: {
        tenantId: tenant.tenantId, reference: `LN-${n}`, applicationId: app.id, clientId: client.id, productId: tenant.productId,
        principal: 300_000, totalInterest: 15_000, initiationFee: 0, totalRepayable: 335_700, outstandingPrincipal: 300_000,
        startDate: at("2026-06-01"), maturityDate: at("2026-09-01"), interestRatePm: 0.05, interestModel: "FLAT", status: "ACTIVE", monthlyServiceFee: 6_900,
      },
    })
    await db.repaymentSchedule.createMany({
      data: ["2026-07-01", "2026-08-01", "2026-09-01"].map((day, i) => ({
        tenantId: tenant.tenantId, loanId: loan.id, installmentNo: i + 1, dueDate: at(day),
        principalDue: 100_000, interestDue: 5_000, feesDue: 6_900, totalDue: 111_900,
      })),
    })
    const contractual = (await loanWithRows(loan.id)).repaymentSchedule as unknown as Row[]
    // 16 July: instalment 1 due and unpaid; instalment 2's interest 15 of 31 days; 3 principal only.
    vi.setSystemTime(at("2026-07-16"))
    const due = currentSettlementAmount({ loan, schedule: contractual as never, asOf: at("2026-07-16") })
    expect(due).toBe(111_900 + 100_000 + Math.round((5_000 * 15) / 31) + 100_000)
    const { payment } = await capture(tenant.tenantId, tenant.userId, loan.id, due, "2026-07-16")
    expect(await db.loan.findUniqueOrThrow({ where: { id: loan.id } })).toMatchObject({ status: "COMPLETED", totalRepayable: due })

    await reverse(tenant.tenantId, tenant.userId, payment.id)
    const reopened = await loanWithRows(loan.id)
    expect(money(reopened.repaymentSchedule as unknown as Row[])).toEqual(money(contractual))
    expect(reopened).toMatchObject({ status: "ACTIVE", totalRepayable: 335_700, totalInterest: 15_000 })
    vi.useRealTimers()
  })
})
