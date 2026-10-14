// TEST-ONLY independent oracle for the structure solver.
//
// Deliberately naive and structured differently from lib/asset-finance/structure.ts:
// it walks EVERY calendar day from the start date with JS Date objects, looks
// the rate up by scanning the whole rate path with string comparison, adds
// balance × rate / 365 into an unrounded accumulator, and only at a due date
// rounds the accumulator (Math.round) and applies the payment. The base
// instalment is found by bisection on the unrounded day walk, not by the
// solver's closed form. It imports the shared TYPES only.
import type { RatePoint, StructureInput } from "../types"

const MS_PER_DAY = 86_400_000

export interface OracleDeal {
  openingCents: number
  startDate: string
  dueDates: string[]
  weights: number[]
  lumpsCents: number[] // extra fixed payment per period (the VAT-deferral lump)
  ratePath: RatePoint[]
  balloonCents: number
}

export interface OracleRow {
  dueDate: string
  interestCents: number
  paymentCents: number // regular payment, excluding the balloon
  balanceAfterPaymentCents: number // before the balloon is paid
}

interface OracleDay {
  rate: number
  dueIndex: number // -1 when the day is not a due date
}

function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

// Month arithmetic by letting Date.UTC normalise an overflowing month, and the
// month length by asking for "day 0 of the next month".
export function oracleDueDates(startDate: string, firstDueDate: string | undefined, n: number): string[] {
  const anchor = new Date(`${firstDueDate ?? startDate}T00:00:00Z`)
  const offset = firstDueDate === undefined ? 1 : 0
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const year = anchor.getUTCFullYear()
    const month = anchor.getUTCMonth() + i + offset
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    out.push(isoOf(Date.UTC(year, month, Math.min(anchor.getUTCDate(), lastDay))))
  }
  return out
}

export function oracleDealFromInput(input: StructureInput): OracleDeal {
  const n = input.weights.length
  const lumps = new Array<number>(n).fill(0)
  if (input.vatDeferralPeriods) lumps[input.vatDeferralPeriods.periodIndex] = input.vatDeferralPeriods.vatCents
  return {
    openingCents:
      input.cashPriceCents - input.depositCents - input.tradeInCents + input.financedFeesCents,
    startDate: input.startDate,
    dueDates: oracleDueDates(input.startDate, input.firstDueDate, n),
    weights: input.weights,
    lumpsCents: lumps,
    ratePath: input.ratePath,
    balloonCents: input.balloonCents,
  }
}

function calendar(deal: OracleDeal): OracleDay[] {
  const days: OracleDay[] = []
  let ms = Date.parse(`${deal.startDate}T00:00:00Z`)
  let next = 0
  while (next < deal.dueDates.length) {
    ms += MS_PER_DAY
    const iso = isoOf(ms)
    if (iso > deal.dueDates[next]) throw new Error(`oracle: walked past due date ${deal.dueDates[next]}`)
    let rate = Number.NaN
    for (const point of deal.ratePath) if (point.effectiveDate <= iso) rate = point.annualRate
    const isDue = iso === deal.dueDates[next]
    days.push({ rate, dueIndex: isDue ? next : -1 })
    if (isDue) next++
  }
  return days
}

type PaymentRule = (index: number, balance: number, interest: number) => number

function walk(deal: OracleDeal, days: OracleDay[], round: boolean, pay: PaymentRule): OracleRow[] {
  const rows: OracleRow[] = []
  let balance = deal.openingCents
  let accrued = 0
  for (const day of days) {
    accrued += (balance * day.rate) / 365
    if (day.dueIndex < 0) continue
    const interest = round ? Math.round(accrued) : accrued
    const payment = pay(day.dueIndex, balance, interest)
    balance = balance + interest - payment
    rows.push({
      dueDate: deal.dueDates[day.dueIndex],
      interestCents: interest,
      paymentCents: payment,
      balanceAfterPaymentCents: balance,
    })
    accrued = 0
  }
  return rows
}

/** Applies exactly the payments given (one per period, excluding the balloon). */
export function oracleReplay(deal: OracleDeal, payments: number[]): OracleRow[] {
  return walk(deal, calendar(deal), true, (i) => payments[i])
}

/**
 * The documented rule from first principles: period i pays round(B × weight)
 * plus its lump; the last period instead pays whatever brings the balance to
 * the balloon.
 */
export function oracleFromBase(deal: OracleDeal, baseCents: number): OracleRow[] {
  const last = deal.dueDates.length - 1
  return walk(deal, calendar(deal), true, (i, balance, interest) =>
    i === last
      ? balance + interest - deal.balloonCents
      : Math.round(baseCents * deal.weights[i]) + deal.lumpsCents[i],
  )
}

/** Real-valued B (no rounding anywhere) by bisection on the day walk. */
export function oracleRealBase(deal: OracleDeal): number {
  const days = calendar(deal)
  const finalBalance = (b: number): number => {
    const rows = walk(deal, days, false, (i) => b * deal.weights[i] + deal.lumpsCents[i])
    return rows[rows.length - 1].balanceAfterPaymentCents
  }
  let lo = 0
  let hi = deal.openingCents
  while (finalBalance(hi) > deal.balloonCents) hi *= 2
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (finalBalance(mid) > deal.balloonCents) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}
