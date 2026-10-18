import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it, vi } from "vitest"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import type { ChargesTx } from "@/lib/loan/charges-replay"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { repriceLoanForReference, type RepriceTx } from "./reprice-loan"
import { createBookedContractFixture, cleanupBookedContractFixture } from "./portal-contract.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate } from "./dates"
import type { SessionUser } from "./payout-booking.integration-fixture"
const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
const suite = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
suite("rate changes preserve permanently blocked common-law interest", () => {
  afterAll(async () => { await db.$disconnect() })
  it("a late cut on a paid capped period neither revives interest nor creates phantom principal", async () => {
    const fx = await createBookedContractFixture(db, randomUUID().replaceAll("-", "").slice(0,16), (user) => { session.current = user && { user } }, { dealAStructure: { periods: 120, rateMargin: "0.25" } })
    try {
      await testSetup(db,
        [`UPDATE "Loan" SET "startDate" = "startDate" - INTERVAL '9 years', "maturityDate" = "maturityDate" - INTERVAL '9 years' WHERE "id" = $1`, fx.loanId],
        [`UPDATE "RepaymentSchedule" SET "dueDate" = "dueDate" - INTERVAL '9 years' WHERE "loanId" = $1`, fx.loanId],
        [`UPDATE "ContractRate" SET "effectiveDate" = "effectiveDate" - INTERVAL '9 years' WHERE "loanId" = $1`, fx.loanId])
      const now = new Date()
      await db.$transaction((tx) => syncLoanCharges(tx as unknown as ChargesTx, { tenantId: fx.tenantId, loanId: fx.loanId }, now, { source: "rate-cap-proof" }))
      const load = () => db.loan.findUniqueOrThrow({ where: { id: fx.loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
      const capped = await load()
      const past = capped.repaymentSchedule.filter((row) => row.dueDate < now)
      expect(past.some((row) => row.commonLawContractualInterestDue !== null && row.interestDue === 0)).toBe(true)
      await applyManualReceipt(db as unknown as PaymentDb, { tenantId: fx.tenantId, loanId: fx.loanId, amount: past.reduce((sum,row) => sum + row.totalDue,0), capturedById: fx.adminA })
      const before = await load()
      expect(before.status).toBe("ACTIVE")
      const blocked = before.repaymentSchedule.filter((row) => row.status === "PAID" && row.commonLawContractualInterestDue !== null && row.interestDue === 0).at(-1)!
      expect(blocked).toBeDefined()
      const effectiveDate = sastCalendarDate(before.repaymentSchedule[blocked.installmentNo - 2].dueDate)
      const rate = await db.referenceRate.create({ data: { tenantId: fx.tenantId, basis: "PRIME", effectiveDate: dbDate(effectiveDate), rate: "0.10", requestedById: fx.officer } })
      await db.referenceRate.update({ where: { id: rate.id }, data: { status: "APPROVED", decidedById: fx.adminA, decidedAt: now } })
      const result = await db.$transaction((tx) => repriceLoanForReference(tx as unknown as RepriceTx, { tenantId: fx.tenantId, loanId: fx.loanId, basis: "PRIME", effectiveDate, runDate: sastCalendarDate(now) }), { timeout: 60000 })
      expect(result.kind).toBe("repriced")
      const after = await load()
      const row = after.repaymentSchedule.find((row) => row.id === blocked.id)!
      expect(row.interestDue).toBe(0)
      expect(row.principalDue).toBe(blocked.principalDue)
      expect(row.totalPaid).toBe(blocked.totalPaid)
      expect(row.commonLawContractualInterestDue).toBeLessThan(blocked.commonLawContractualInterestDue!)
      expect(after.principal).toBe(before.principal)
      const settlement = await loanSettlementFigures(db as unknown as ChargesTx, after, now)
      await applyManualReceipt(db as unknown as PaymentDb, { tenantId: fx.tenantId, loanId: fx.loanId, amount: settlement.totalToSettle, capturedById: fx.adminA })
      expect((await load()).status).toBe("COMPLETED")
      const nextDate = sastCalendarDate(blocked.dueDate)
      const next = await db.referenceRate.create({ data: { tenantId: fx.tenantId, basis: "PRIME", effectiveDate: dbDate(nextDate), rate: "0.11", requestedById: fx.officer } })
      await db.referenceRate.update({ where: { id: next.id }, data: { status: "APPROVED", decidedById: fx.adminA, decidedAt: now } })
      expect((await db.$transaction((tx) => repriceLoanForReference(tx as unknown as RepriceTx, { tenantId: fx.tenantId, loanId: fx.loanId, basis: "PRIME", effectiveDate: nextDate, runDate: sastCalendarDate(now) }), { timeout: 60000 })).kind).toBe("repriced")
      // The increase falls entirely inside an already-blocked historical
      // period. Contractual interest rises, but no lawful debit can revive it.
      expect((await db.assetFinanceRateCorrection.findFirstOrThrow({ where: { loanId: fx.loanId } })).amountCents).toBe(0)

    } finally { await cleanupBookedContractFixture(db, fx) }
  }, 120000)
})
