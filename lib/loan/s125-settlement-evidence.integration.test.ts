/**
 * Real-Postgres proof that the database accepts an early instalment settlement
 * (migration 20261016200000_s125_instalment_settlement) only on the evidence a
 * receipt writer records: an audit row of a receipt action naming this loan,
 * for a live receipt of exactly the settlement figure, recording the contract
 * as acknowledged, over a schedule that still owes in full every row due by
 * the receipt's value date. Each forgery is refused; the honest settlement it
 * was cut from is accepted, so each refusal is that forgery's alone.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/loan/s125-settlement-evidence.integration.test.ts
 */
import { PrismaClient, type Prisma } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { bookLoan, createApprovedPasqV3Application, type PasqV3Scenario } from "@/lib/compliance/pasq-v3-application.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const at = (iso: string) => new Date(`${iso}T10:00:00+02:00`)
const REFUSED = /Early instalment settlement does not preserve PASQ v3 contractual and ledger evidence/

type Row = Prisma.RepaymentScheduleGetPayload<object>
interface Forgery {
  action?: string
  entity?: string
  entityId?: (loanId: string, paymentId: string) => string
  /** reverse the named receipt and carry the money on another */
  reversed?: boolean
  settlementDue?: (amount: number) => number
  recorded?: (rows: Array<Record<string, unknown>>) => void
  /** the re-priced rows; row 0 fell due before the settlement date */
  rows?: (rows: Row[]) => Row[]
}

suite.sequential("early instalment settlement evidence (real Postgres)", () => {
  let scenario: PasqV3Scenario
  let loanId = ""
  let otherLoanId = ""
  let contract: Row[] = []
  let settleOn = new Date()

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: at("2026-07-24") })
    scenario = await createApprovedPasqV3Application("s125-evidence", "ACCEPTED", true, "DEFERRED", false, null, {
      pricing: {
        principal: 1_000_000, termDays: 180, productType: "PERSONAL", interestRatePm: 0.02, interestModel: "REDUCING_BALANCE",
        initiationFeeModel: "NCA_REG42", initiationFeePct: 0.15, initiationFeeMax: 105_000, monthlyServiceFee: 6_900,
        initiationFeePayment: "DEFERRED",
      },
    })
    loanId = await bookLoan(scenario)
    const other = await createApprovedPasqV3Application("s125-evidence-other", "ACCEPTED", true, "DEFERRED", false, null, { pricing: scenario.pricing })
    otherLoanId = await bookLoan(other)
    contract = await db.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
    // The day after instalment 1 fell due: it is owed whole, 2 is the current period.
    settleOn = new Date(contract[0].dueDate.getTime() + 86_400_000)
  }, 180_000)
  afterAll(() => {
    vi.useRealTimers()
  })

  /** The honest s125 re-pricing: 1 unchanged, 2 principal and some interest, the rest principal only. */
  const honest = (rows: Row[]): Row[] => rows.map((row, i) => i === 0 ? row : {
    ...row,
    interestDue: i === 1 ? Math.floor(row.interestDue / 30) : 0,
    feesDue: 0, creditLifePremiumDue: 0,
    totalDue: row.principalDue + (i === 1 ? Math.floor(row.interestDue / 30) : 0),
  })

  async function settle(forgery: Forgery = {}) {
    const repriced = (forgery.rows ?? honest)(contract.map((row) => ({ ...row })))
    const total = repriced.reduce((sum, row) => sum + row.totalDue, 0)
    const totalInterest = repriced.reduce((sum, row) => sum + row.interestDue, 0)
    const evidence = scenario.pasqEvidence
    await db.$transaction(async (tx) => {
      const payment = await tx.payment.create({
        data: { tenantId: scenario.tenantId, loanId, amount: total, paymentMethod: "EFT", capturedBy: scenario.officerId, receivedAt: settleOn },
      })
      if (forgery.reversed) {
        await tx.payment.update({ where: { id: payment.id }, data: { reversed: true, reversedAt: settleOn, reversalReason: "IT" } })
        await tx.payment.create({
          data: { tenantId: scenario.tenantId, loanId, amount: total, paymentMethod: "EFT", capturedBy: scenario.officerId, receivedAt: settleOn },
        })
      }
      for (const row of repriced) {
        await tx.repaymentSchedule.update({
          where: { id: row.id },
          data: {
            interestDue: row.interestDue, feesDue: row.feesDue, creditLifePremiumDue: row.creditLifePremiumDue,
            totalDue: row.totalDue, totalPaid: row.totalDue, status: "PAID", paidAt: settleOn,
          },
        })
      }
      await tx.loan.update({
        where: { id: loanId },
        data: { totalInterest, totalRepayable: total, totalPaid: total, outstandingPrincipal: 0, status: "COMPLETED", closedAt: settleOn },
      })
      const recorded = contract.map((row) => ({
        id: row.id, installmentNo: row.installmentNo, principalDue: row.principalDue, interestDue: row.interestDue,
        feesDue: row.feesDue, creditLifePremiumDue: row.creditLifePremiumDue, totalDue: row.totalDue,
      }))
      forgery.recorded?.(recorded)
      await tx.auditLog.create({
        data: {
          tenantId: scenario.tenantId, userId: scenario.officerId,
          action: forgery.action ?? "PAYMENT_RECORDED",
          entity: forgery.entity ?? "Loan",
          entityId: (forgery.entityId ?? ((id) => id))(loanId, payment.id),
          newValue: {
            paymentId: payment.id, loanId, earlyInstalmentSettlement: true,
            settlementDue: (forgery.settlementDue ?? ((amount) => amount))(total),
            resultingTotalInterest: totalInterest, resultingTotalRepayable: total,
            interestRebate: evidence.calculator.totalInterestCents - totalInterest,
            contractualTotalInterest: evidence.calculator.totalInterestCents,
            contractualTotalRepayable: evidence.billing.totalRepayableCents,
            contractualRows: recorded,
          },
        },
      })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    })
  }

  it("refuses settlement evidence on any audit row but a receipt writer's", async () => {
    await expect(settle({ action: "ATTORNEY_UPDATED", entity: "Attorney" })).rejects.toThrow(/AuditLog_settlement_evidence_receipts_only/)
  })

  it("refuses a receipt action that does not name this loan's receipt", async () => {
    await expect(settle({ entityId: () => otherLoanId })).rejects.toThrow(REFUSED)
    await expect(settle({ action: "PAYMENT_ALLOCATED", entity: "Loan" })).rejects.toThrow(REFUSED)
    await expect(settle({ action: "PAYMENT_ALLOCATED", entity: "Payment", entityId: () => "not-the-receipt" })).rejects.toThrow(REFUSED)
  })

  it("refuses a reversed receipt, or one that is not the settlement figure", async () => {
    await expect(settle({ reversed: true })).rejects.toThrow(REFUSED)
    await expect(settle({ settlementDue: (amount) => amount - 1 })).rejects.toThrow(REFUSED)
  })

  it("refuses recorded contractual rows that are not the acknowledged contract on this loan", async () => {
    await expect(settle({ recorded: (rows) => { rows[3].interestDue = Number(rows[3].interestDue) + 1 } })).rejects.toThrow(REFUSED)
    const foreign = await db.repaymentSchedule.findFirstOrThrow({ where: { loanId: otherLoanId, installmentNo: 4 } })
    await expect(settle({ recorded: (rows) => { rows[3].id = foreign.id } })).rejects.toThrow(REFUSED)
  })

  it("refuses a re-pricing of a row already due, or interest beyond the current period", async () => {
    const zeroed = (rows: Row[]) => honest(rows).map((row, i) => i === 0
      ? { ...row, interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: row.principalDue }
      : row)
    await expect(settle({ rows: zeroed })).rejects.toThrow(REFUSED)
    const late = (rows: Row[]) => honest(rows).map((row, i) => i === 2 ? { ...row, interestDue: 100, totalDue: row.principalDue + 100 } : row)
    await expect(settle({ rows: late })).rejects.toThrow(REFUSED)
    const premium = (rows: Row[]) => honest(rows).map((row, i) => i === 3 ? { ...row, creditLifePremiumDue: 2_250 } : row)
    await expect(settle({ rows: premium })).rejects.toThrow(REFUSED)
  })

  it("accepts the honest settlement every forgery was cut from", async () => {
    await settle()
    expect(await db.loan.findUniqueOrThrow({ where: { id: loanId } })).toMatchObject({ status: "COMPLETED", outstandingPrincipal: 0 })
  })
})
