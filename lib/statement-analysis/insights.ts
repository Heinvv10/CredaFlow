/**
 * Financial-health figures from a client's read statements: money in and out
 * per month, balances, how regular the salary is, spend by category, and
 * living spend against the client's declared monthly expenses. A pure
 * function of the stored reads, the client's name and declared expenses,
 * computed on every request (categories are never stored).
 *
 * Only statements that pass the balance check count: an unreconciled read may
 * have dropped or misread rows, and spend from it would be a guess. Two
 * statements of one account that overlap count each day once.
 */
import { EXPENSE_MIN_COVERAGE_DAYS } from "@/lib/credit-checks/policy"
import { MONTH_DAYS } from "./categories"
import { categorise, CATEGORISER_VERSION, isLiving, type Category, type LivingCategory } from "./categorise"
import type { StatementRead, StatementTransaction } from "./types"


export interface InsightStatement {
  documentId: string
  bank: string | null
  balanceCheck: string | null
  read: StatementRead
}

export interface StatementSummary {
  documentId: string
  bank: string | null
  periodStart: string | null
  periodEnd: string | null
  /** Reconciles, so its rows count in the combined figures. */
  used: boolean
  averageBalanceCents: number | null
  lowestBalanceCents: number | null
}

export interface MonthFigures {
  month: string
  inCents: number
  outCents: number
  /** Money out per category, positive cents. */
  byCategory: Partial<Record<Category, number>>
  salaryCredits: number
}

export interface Insights {
  categoriserVersion: string
  statements: StatementSummary[]
  /** Days covered by the reconciling statements, overlaps counted once. */
  coverageDays: number
  enoughCoverage: boolean
  months: MonthFigures[]
  salary: { payDays: number[]; daySpread: number | null }
  /** Share of money out (by value) no category could be given. */
  uncategorisedShare: number | null
  living: {
    monthlyCents: number
    byCategoryMonthlyCents: Partial<Record<LivingCategory, number>>
    /** Money out not counted as living spend, per month: shown, never compared. */
    excludedMonthlyCents: Partial<Record<Category, number>>
  }
  declaredCents: number | null
  gapCents: number | null
}

const dayMs = 86_400_000
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / dayMs) + 1
const isoPlus = (iso: string, n: number) => new Date(Date.parse(iso) + n * dayMs).toISOString().slice(0, 10)

function period(read: StatementRead): [string, string] | null {
  const dates = read.transactions.map((t) => t.date).sort()
  const start = read.periodStart ?? dates[0]
  const end = read.periodEnd ?? dates[dates.length - 1]
  return start && end && start <= end ? [start, end] : null
}

/** End-of-day balances over the statement's period: their mean and lowest. */
function balances(read: StatementRead): { average: number | null; lowest: number | null } {
  const p = period(read)
  if (!p) return { average: null, lowest: null }
  let running = read.openingBalanceCents
  const endOfDay = new Map<string, number>()
  for (const t of read.transactions) {
    if (t.nonPosting) continue
    running = t.balanceCents ?? (running === null ? null : running + t.amountCents)
    if (running !== null) endOfDay.set(t.date, running)
  }
  let current = read.openingBalanceCents
  const series: number[] = []
  for (let i = 0; i < days(p[0], p[1]); i++) {
    current = endOfDay.get(isoPlus(p[0], i)) ?? current
    if (current !== null) series.push(current)
  }
  if (series.length === 0) return { average: null, lowest: null }
  return { average: Math.round(series.reduce((a, b) => a + b, 0) / series.length), lowest: Math.min(...series) }
}

/** Days covered by a set of periods, overlaps once. */
function unionDays(periods: Array<[string, string]>): number {
  let total = 0
  let end: string | null = null
  for (const [s, e] of [...periods].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (end === null || s > end) total += days(s, e)
    else if (e > end) total += days(end, e) - 1
    if (end === null || e > end) end = e
  }
  return total
}

/** The used statements' rows, each account's days counted once (a later statement adds only days after the earlier). */
function distinctRows(used: InsightStatement[]): StatementTransaction[] {
  const coveredTo = new Map<string, string>()
  const rows: StatementTransaction[] = []
  for (const s of [...used].sort((a, b) => (period(a.read)?.[0] ?? "").localeCompare(period(b.read)?.[0] ?? ""))) {
    // Without the account number each statement is its own account: two accounts
    // merged would drop real spend (a missed referral); an overlap counted twice
    // only over-refers, which an officer clears.
    const account = `${s.bank}|${s.read.accountNumberLast4 ?? s.documentId}`
    const after = coveredTo.get(account)
    rows.push(...s.read.transactions.filter((t) => !t.nonPosting && (!after || t.date > after)))
    const end = period(s.read)?.[1]
    if (end && (!after || end > after)) coveredTo.set(account, end)
  }
  return rows
}

const add = <K extends string>(m: Partial<Record<K, number>>, k: K, v: number) => { m[k] = (m[k] ?? 0) + v }

export function computeInsights(
  statements: InsightStatement[],
  ctx: { clientName: string | null; declaredExpensesCents: number | null },
): Insights {
  const used = statements.filter((s) => s.balanceCheck === "PASS")
  const coverageDays = unionDays(used.map((s) => period(s.read)).filter((p): p is [string, string] => p !== null))
  const perMonth = coverageDays / MONTH_DAYS
  const months = new Map<string, MonthFigures>()
  const spend: Partial<Record<Category, number>> = {}
  let debitTotal = 0
  for (const t of distinctRows(used)) {
    const key = t.date.slice(0, 7)
    const m = months.get(key) ?? { month: key, inCents: 0, outCents: 0, byCategory: {}, salaryCredits: 0 }
    const { category } = categorise(t, { clientName: ctx.clientName })
    if (t.amountCents > 0) {
      m.inCents += t.amountCents
      if (category === "SALARY_INCOME") m.salaryCredits++
    } else {
      m.outCents -= t.amountCents
      add(m.byCategory, category, -t.amountCents)
      add(spend, category, -t.amountCents)
      debitTotal -= t.amountCents
    }
    months.set(key, m)
  }
  const monthly = (v: number) => (perMonth > 0 ? Math.round(v / perMonth) : 0)
  const living: Insights["living"] = { monthlyCents: 0, byCategoryMonthlyCents: {}, excludedMonthlyCents: {} }
  for (const [c, v] of Object.entries(spend) as Array<[Category, number]>) {
    if (isLiving(c)) living.byCategoryMonthlyCents[c] = monthly(v)
    else living.excludedMonthlyCents[c] = monthly(v)
  }
  living.monthlyCents = monthly(Object.entries(spend).reduce((sum, [c, v]) => sum + (isLiving(c as Category) ? v : 0), 0))
  const payDays = distinctRows(used)
    .filter((t) => t.amountCents > 0 && categorise(t, { clientName: ctx.clientName }).category === "SALARY_INCOME")
    .reduce((firsts, t) => firsts.set(t.date.slice(0, 7), Math.min(firsts.get(t.date.slice(0, 7)) ?? 31, Number(t.date.slice(8, 10)))), new Map<string, number>())
  const salaryDays = [...payDays.values()]
  const declared = ctx.declaredExpensesCents
  return {
    categoriserVersion: CATEGORISER_VERSION,
    statements: statements.map((s) => {
      const b = balances(s.read)
      return { documentId: s.documentId, bank: s.bank, periodStart: s.read.periodStart, periodEnd: s.read.periodEnd, used: s.balanceCheck === "PASS", averageBalanceCents: b.average, lowestBalanceCents: b.lowest }
    }),
    coverageDays,
    enoughCoverage: coverageDays >= EXPENSE_MIN_COVERAGE_DAYS,
    months: [...months.values()].sort((a, b) => a.month.localeCompare(b.month)),
    salary: { payDays: salaryDays, daySpread: salaryDays.length ? Math.max(...salaryDays) - Math.min(...salaryDays) : null },
    uncategorisedShare: debitTotal > 0 ? (spend.UNCATEGORISED ?? 0) / debitTotal : null,
    living,
    declaredCents: declared,
    // Under four weeks there is no month to compare: no gap.
    gapCents: declared === null || coverageDays < EXPENSE_MIN_COVERAGE_DAYS ? null : living.monthlyCents - declared,
  }
}
