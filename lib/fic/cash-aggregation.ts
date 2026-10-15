import { southAfricanCalendarDate } from "@/lib/compliance/sa-business-days"
import { CASH_THRESHOLD_CENTS } from "./cash-threshold"

/**
 * Possible split deposits: one client's CASH receipts on one SAST calendar
 * day, each BELOW the threshold, that together reach it. A flag for the
 * compliance officer to look at, not a reportable transaction: whether and
 * how the FIC requires aggregation was not verified (see cash-threshold.ts).
 */
export type CashReceipt = { paymentId: string; clientId: string | null; amount: number; receivedAt: Date; reversed: boolean; paymentMethod: string }

export type CashAggregate = {
  clientId: string
  day: string
  totalCents: number
  paymentIds: string[]
}

export function cashAggregates(receipts: CashReceipt[]): CashAggregate[] {
  const groups = new Map<string, CashAggregate>()
  for (const r of receipts) {
    if (r.paymentMethod !== "CASH" || r.reversed || !r.clientId || r.amount >= CASH_THRESHOLD_CENTS) continue
    const day = southAfricanCalendarDate(r.receivedAt)
    const key = `${r.clientId}|${day}`
    const group = groups.get(key) ?? { clientId: r.clientId, day, totalCents: 0, paymentIds: [] }
    group.totalCents += r.amount
    group.paymentIds.push(r.paymentId)
    groups.set(key, group)
  }
  return [...groups.values()]
    .filter((g) => g.paymentIds.length > 1 && g.totalCents >= CASH_THRESHOLD_CENTS)
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : a.clientId.localeCompare(b.clientId)))
}
