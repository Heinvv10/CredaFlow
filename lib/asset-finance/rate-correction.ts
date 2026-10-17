/** Late closed-book correction. Replays original cash at its value dates;
 * no receipt, signed schedule, or executed refund is invented. */
import type { DefaultChargeInput } from "@/lib/loan/default-charges"
import { loadChargesReplay } from "@/lib/loan/charges-replay"
import { lawfulRateCorrection } from "./lawful-rate-correction"
import type { RepriceTx } from "./reprice-loan"
import { sastCalendarDate } from "@/lib/date/sast"
import { allocateReceipts } from "@/lib/loan/balances"
import { periodInterest } from "./amortise"
import { rateDaySum, rateSegments } from "./rates"
import { toDayNumber } from "./dates"
import type { RatePoint } from "./types"

export function correctionCashEvents(rows: Array<{ totalDue: number; interestDue: number; feesDue: number }>, receipts: Array<{ amount: number; receivedAt: Date; defaultInterestAllocated: number; chargeFeesAllocated: number }>) {
  let cumulative = 0, priorFees = 0
  return receipts.map((receipt) => {
    const cash = receipt.amount - receipt.defaultInterestAllocated - receipt.chargeFeesAllocated
    cumulative += cash
    const allocated = allocateReceipts(rows, cumulative)
    const fees = rows.reduce((sum, row, i) => sum + Math.min(row.feesDue, Math.max(0, allocated[i] - row.interestDue)), 0)
    const capitalCashCents = cash - (fees - priorFees)
    priorFees = fees
    return { day: sastCalendarDate(receipt.receivedAt), capitalCashCents }
  })
}

export function correctionBalance(principalCents: number, startDate: string, path: RatePoint[], events: Array<{ day: string; capitalCashCents: number }>): number {
  const segments = rateSegments(path, toDayNumber(startDate))
  let balance = principalCents, priorDay = toDayNumber(startDate)
  for (const event of events) {
    const day = toDayNumber(event.day)
    if (day < priorDay) throw new Error("Rate-correction receipts must be in value-date order")
    balance += periodInterest(Math.max(0, balance), rateDaySum(segments, priorDay, day)) - event.capitalCashCents
    priorDay = day
  }
  return balance
}

interface CorrectionEvidence {
  rows: Array<{ totalDue: number; interestDue: number; feesDue: number }>
  principalCents: number
  startDate: string
  billedPath: RatePoint[]
  correctedPath: RatePoint[]
}

/** Receipt reversals change the basis of an unexecuted correction. Append the
 * difference immediately, keeping both the old statement and immutable cash. */
export async function reconcileRateCorrections(tx: Pick<RepriceTx, "assetFinanceRateCorrection" | "payment" | "loan" | "complianceRecord" | "loanCharge" | "repaymentSchedule" | "auditLog">, tenantId: string, loanId: string, cause: string, sourceRows?: DefaultChargeInput["schedule"]) {
  if (await tx.assetFinanceRateCorrection.findUnique({ where: { cause } })) return
  const ledger = await tx.assetFinanceRateCorrection.findMany({ where: { tenantId, loanId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
  const latest = ledger.filter((row) => ["LATE_CLOSED_BOOK_RATE", "FIXED_NOTICE_WINDOW_RATE"].includes(row.reason)).at(-1)
  if (!latest || ledger.some((row) => row.reason === "APPLIED_TO_SCHEDULE" && row.createdAt >= latest.createdAt)) return
  const evidence = latest.contractualRows as unknown as CorrectionEvidence
  const receipts = await tx.payment.findMany({ where: { tenantId, loanId, reversed: false, allocationStatus: "ALLOCATED" }, orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }], select: { amount: true, receivedAt: true, defaultInterestAllocated: true, chargeFeesAllocated: true } })
  const events = correctionCashEvents(evidence.rows, receipts)
  let target = correctionBalance(evidence.principalCents, evidence.startDate, evidence.correctedPath, events) - correctionBalance(evidence.principalCents, evidence.startDate, evidence.billedPath, events)
  const replay = await loadChargesReplay(tx, { tenantId, loanId }, new Date(), { decidingStatus: true })
  if (replay?.loan.ncaRegime === "NON_NCA") target = lawfulRateCorrection(replay, sourceRows ?? replay.loan.repaymentSchedule, evidence.startDate, evidence.billedPath, evidence.correctedPath, new Date())
  const previous = ledger.reduce((sum, row) => sum + row.amountCents, 0)
  await tx.assetFinanceRateCorrection.create({ data: { tenantId, loanId, contractRateId: latest.contractRateId, cause, amountCents: target - previous, cumulativeAmountCents: target, reason: "RECEIPT_RECONCILIATION", contractualRows: { ...evidence, events } as never } })
}
