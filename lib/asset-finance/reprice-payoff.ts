import { sastCalendarDate } from "@/lib/date/sast"
import { toDayNumber } from "./dates"
import { periodInterest } from "./amortise"
import { rateDaySum, rateSegments } from "./rates"
import type { StoredScheduleRow } from "./stored-schedule"
import type { RatePoint } from "./types"

export function ratePayoffPlan(input: { rows: StoredScheduleRow[]; paidThroughIndex: number; financedAmountCents: number; startDate: string; ratePath: RatePoint[]; lawfulInterestCents?: number[] }) {
  let capital = input.financedAmountCents
  let payoffIndex = -1
  const segments = rateSegments(input.ratePath, toDayNumber(input.startDate))
  const rows = input.rows.map((original, index) => {
    const opening = Math.max(0, capital)
    if (payoffIndex >= 0) return { ...original, principalDue: 0, interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: 0, assetFinanceOpeningBalanceCents: 0 }
    const from = index === 0 ? input.startDate : sastCalendarDate(input.rows[index - 1].dueDate)
    const accrued = periodInterest(opening, rateDaySum(segments, toDayNumber(from), toDayNumber(sastCalendarDate(original.dueDate))))
    const interest = input.lawfulInterestCents?.[index] ?? accrued
    const cash = (original.collectibleTotalDue ?? original.totalDue) - original.feesDue
    const principal = Math.min(opening, Math.max(0, cash - interest))
    capital = opening + interest - cash
    if (capital <= 0 && index <= input.paidThroughIndex) payoffIndex = index
    return { ...original, principalDue: principal, interestDue: Math.min(interest, cash), totalDue: principal + Math.min(interest, cash) + original.feesDue,
      assetFinanceOpeningBalanceCents: opening }
  })
  if (payoffIndex < 0) throw new Error("Rate-payoff plan does not repay the capital from recorded past instalments")
  const cashPaid = input.rows.reduce((sum,row) => sum + row.totalPaid,0)
  const amountDue = rows.reduce((sum,row) => sum + row.totalDue,0)
  return { rows, payoffIndex, payoffDate: sastCalendarDate(rows[payoffIndex].dueDate), refundCents: cashPaid - amountDue, amountDue }
}
