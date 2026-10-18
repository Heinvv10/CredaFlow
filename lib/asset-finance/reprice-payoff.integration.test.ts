import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { createBookedContractFixture, cleanupBookedContractFixture } from "./portal-contract.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { repriceLoanForReference, type RepriceTx } from "./reprice-loan"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate } from "./dates"
import type { SessionUser } from "./payout-booking.integration-fixture"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
suite("large late rate reduction pays off a real active account", () => {
  afterAll(async () => { vi.useRealTimers(); await db.$disconnect() })
  it("ends the remaining debt at zero and conserves cash as a pending refund, including retry", async () => {
    const actualNow = new Date()
    const fx = await createBookedContractFixture(db, randomUUID().replaceAll("-", "").slice(0,16), (user) => { session.current = user && { user } }, { dealAStructure: { periods: 72, rateMargin: "0.01" } })
    try {
      await testSetup(db,
        [`UPDATE "Loan" SET "startDate" = "startDate" - INTERVAL '60 months', "maturityDate" = "maturityDate" - INTERVAL '60 months' WHERE "id" = $1`, fx.loanId],
        [`UPDATE "RepaymentSchedule" SET "dueDate" = "dueDate" - INTERVAL '60 months' WHERE "loanId" = $1`, fx.loanId],
        [`UPDATE "ContractRate" SET "effectiveDate" = "effectiveDate" - INTERVAL '60 months' WHERE "loanId" = $1`, fx.loanId])
      const original = await db.loan.findUniqueOrThrow({ where: { id: fx.loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
      vi.useFakeTimers({ toFake: ["Date"] })
      for (const row of original.repaymentSchedule.slice(0,59)) {
        vi.setSystemTime(new Date(row.dueDate.getTime() + 12*3600000))
        await applyManualReceipt(db as unknown as PaymentDb, { tenantId: fx.tenantId, loanId: fx.loanId, amount: row.totalDue, capturedById: fx.adminA })
      }
      vi.setSystemTime(actualNow)
      const before = await db.loan.findUniqueOrThrow({ where: { id: fx.loanId } })
      expect(before.status).toBe("ACTIVE")
      const start = sastCalendarDate(original.startDate)
      const effectiveDate = new Date(dbDate(start).getTime() + 86400000).toISOString().slice(0,10)
      const ref = await db.referenceRate.create({ data: { tenantId: fx.tenantId, basis: "PRIME", effectiveDate: dbDate(effectiveDate), rate: "0.001", requestedById: fx.officer } })
      await db.referenceRate.update({ where: { id: ref.id }, data: { status: "APPROVED", decidedById: fx.adminA, decidedAt: actualNow } })
      let capital = original.principal, earned = 0, previous = dbDate(start).getTime(), payoff = -1
      for (const [i,row] of original.repaymentSchedule.slice(0,59).entries()) {
        if (payoff >= 0) break
        const day = dbDate(sastCalendarDate(row.dueDate)).getTime()
        const interest = Math.round(capital * 0.011 * ((day - previous)/86400000) / 365)
        earned += interest
        capital = capital + interest - row.totalDue
        previous = day
        if (capital <= 0) payoff = i
      }
      expect(capital).toBeLessThan(0)
      const grossCash = original.repaymentSchedule.slice(0,59).reduce((sum,row) => sum + row.totalDue,0)
      const expectedRefund = grossCash - original.principal - earned
      const outcome = await db.$transaction((tx) => repriceLoanForReference(tx as unknown as RepriceTx, { tenantId: fx.tenantId, loanId: fx.loanId, basis: "PRIME", effectiveDate, runDate: sastCalendarDate(actualNow) }), { timeout: 60000 })
      expect(outcome.kind).toBe("repriced")
      const after = await db.loan.findUniqueOrThrow({ where: { id: fx.loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
      expect(after).toMatchObject({ status: "COMPLETED", outstandingPrincipal: 0, totalInterest: earned, totalRepayable: original.principal + earned })
      expect(after.repaymentSchedule.slice(payoff+1).every((row) => row.totalDue === 0)).toBe(true)
      const credit = await db.payment.aggregate({ where: { loanId: fx.loanId, allocationStatus: "UNAPPLIED", reversed: false }, _sum: { amount: true } })
      expect(credit._sum.amount).toBe(expectedRefund)
      expect((await db.payment.aggregate({ where: { loanId: fx.loanId, reversed: false }, _sum: { amount: true } }))._sum.amount).toBe(grossCash)
      expect((await db.assetFinanceRateCorrection.findFirstOrThrow({ where: { loanId: fx.loanId, reason: "RATE_PAYOFF_CREDIT" } })).amountCents).toBe(-expectedRefund)
      expect(await db.$transaction((tx) => repriceLoanForReference(tx as unknown as RepriceTx, { tenantId: fx.tenantId, loanId: fx.loanId, basis: "PRIME", effectiveDate, runDate: sastCalendarDate(actualNow) }))).toEqual({ kind: "already_repriced" })
      expect(await db.assetFinanceRateCorrection.count({ where: { loanId: fx.loanId } })).toBe(1)
    } finally { vi.useRealTimers(); await cleanupBookedContractFixture(db, fx) }
  }, 300000)
})
