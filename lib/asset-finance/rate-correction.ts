/** Late closed-book correction. Replays original cash at its value dates;
 * no receipt, signed schedule, or executed refund is invented. */
import { Prisma } from "@prisma/client"
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

export const correctionDecimal = (value: string) => new Prisma.Decimal(value)
