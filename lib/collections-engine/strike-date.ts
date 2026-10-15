/**
 * Strike-date analysis: which day of the month to debit, and how many tracking
 * days to ask for, from the salary credits on the client's bank statements.
 *
 * Pure. The debit day is the day the salary most often lands (ties: the
 * earliest); tracking days cover the latest observed landing after it. A
 * salary that slips across month end (31st → 1st) is read as late, not early.
 * Without statement evidence, the client's declared pay day is used at low
 * confidence. Advice for staff, never applied without them.
 */
import { SALARY_AMOUNT_TOLERANCE_CENTS, SALARY_AMOUNT_TOLERANCE_PCT, SALARY_CANDIDATE_MIN_SHARE } from "@/lib/credit-checks/policy"
import { MAX_TRACKING_DAYS, MIN_TRACKING_DAYS } from "./scheme-rules"

/** Tracking days suggested when only a declared pay day is known: covers a weekend slip. */
export const DECLARED_PAY_DAY_TRACKING_DAYS = 3

const SALARY_MARKERS = /\b(SALARY|SALARIES|SAL|WAGES?|PAYROLL)\b/i
/** A payday this early in a month, when others fall this late, is last month's salary paid late. */
const WRAP_EARLY_DAY = 7
const WRAP_LATE_DAY = 24
/** Credits closer together than this belong to the same monthly pay cycle. */
const MIN_PAY_CYCLE_GAP_DAYS = 20

export interface StrikeDateInput {
  statements: Array<{
    transactions: Array<{ date: string; amountCents: number; description: string; nonPosting?: true }>
  }>
  /** Validated payslip net pay, if any (credit-checks PayslipFacts). */
  netPayCents: number | null
  /** Client.salaryPaymentDay. */
  declaredPayDay: number | null
}

export interface StrikeDateRecommendation {
  debitDay: number
  trackingDays: number
  confidence: "HIGH" | "MEDIUM" | "LOW"
  basis: "STATEMENT_SALARY" | "DECLARED_PAY_DAY"
  salaryDates: string[]
}

type Credit = { date: string; amountCents: number; description: string }

function salaryCredits(input: StrikeDateInput): Credit[] {
  const credits = input.statements
    .flatMap((s) => s.transactions)
    .filter((t) => t.amountCents > 0 && !t.nonPosting)
  const net = input.netPayCents
  if (net !== null && net > 0) {
    const tolerance = Math.max(SALARY_AMOUNT_TOLERANCE_CENTS, Math.round((net * SALARY_AMOUNT_TOLERANCE_PCT) / 100))
    const exact = credits.filter((c) => Math.abs(c.amountCents - net) <= tolerance)
    return exact.length > 0 ? exact : credits.filter((c) => c.amountCents >= net * SALARY_CANDIDATE_MIN_SHARE)
  }
  return credits.filter((c) => SALARY_MARKERS.test(c.description))
}

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000

/**
 * One salary per pay cycle: the credit nearest the net pay, else the largest.
 * Cycles are clusters of credits less than MIN_PAY_CYCLE_GAP_DAYS apart, not
 * calendar months, so August's salary paid on 1 September is not merged with
 * September's paid on the 30th.
 */
function onePerCycle(credits: Credit[], net: number | null): Credit[] {
  const score = (c: Credit) => (net ? -Math.abs(c.amountCents - net) : c.amountCents)
  const picked: Credit[] = []
  let cycleStart: number | null = null
  for (const c of [...credits].sort((a, b) => a.date.localeCompare(b.date))) {
    const day = dayNumber(c.date)
    if (cycleStart === null || day - cycleStart >= MIN_PAY_CYCLE_GAP_DAYS) {
      cycleStart = day
      picked.push(c)
    } else if (score(c) > score(picked[picked.length - 1])) {
      picked[picked.length - 1] = c
    }
  }
  return picked
}

export function recommendStrikeDate(input: StrikeDateInput): StrikeDateRecommendation | null {
  const salaries = onePerCycle(salaryCredits(input), input.netPayCents)
  if (salaries.length === 0) {
    const day = input.declaredPayDay
    if (day === null || !Number.isInteger(day) || day < 1 || day > 31) return null
    return { debitDay: day, trackingDays: DECLARED_PAY_DAY_TRACKING_DAYS, confidence: "LOW", basis: "DECLARED_PAY_DAY", salaryDates: [] }
  }

  const days = salaries.map((s) => Number(s.date.slice(8, 10)))
  const wraps = days.some((d) => d >= WRAP_LATE_DAY) && days.some((d) => d <= WRAP_EARLY_DAY)
  const positions = days.map((d) => (wraps && d <= WRAP_EARLY_DAY ? d + 31 : d))

  const counts = new Map<number, number>()
  for (const p of positions) counts.set(p, (counts.get(p) ?? 0) + 1)
  const top = Math.max(...counts.values())
  const strike = Math.min(...[...counts].filter(([, n]) => n === top).map(([p]) => p))
  const lateness = Math.max(...positions.map((p) => p - strike))
  const trackingDays = Math.min(MAX_TRACKING_DAYS, Math.max(MIN_TRACKING_DAYS, lateness + 1))

  return {
    debitDay: strike > 31 ? strike - 31 : strike,
    trackingDays,
    confidence: salaries.length >= 3 ? "HIGH" : salaries.length === 2 ? "MEDIUM" : "LOW",
    basis: "STATEMENT_SALARY",
    salaryDates: salaries.map((s) => s.date),
  }
}
