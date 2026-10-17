/**
 * What the model is given, and nothing else (goal §3, §4): the insights
 * figures already computed by code, the raised flags with their evidence-row
 * counts, and masked counterparty keys. Every figure is formatted here, once,
 * and the same strings feed the post-check's allowed set, so "copy the figure
 * as written" is something the check can verify.
 *
 * No client name, ID, account or reference number reaches the model: payees
 * are labelKey() (first three words, digits dropped), and a flag's summary
 * text (which can quote the client's name) is never sent.
 */
import { createHash } from "node:crypto"
import type { ApplicationCheckFlag } from "@prisma/client"
import type { CountedRow, Insights } from "@/lib/statement-analysis/insights"
import { labelKey } from "@/lib/statement-analysis/model-labels"
import type { StatementTransaction } from "@/lib/statement-analysis/types"
import type { Allowed } from "./post-check"
import { flagSpec, type FlagSpecFacts } from "./flag-specs"
import { pct, rand } from "./format"

/** Payee keys that could read as a figure or a judgement are not sent (a client can name a payee). */
const UNSAFE_KEY = /\b(R|ZAR|PERCENT|RAND|FINE|OK|OKAY|NORMAL|RESOLVED|CLEARED|SAFE|IGNORE|APPROVE\w*|DECLINE\w*|GENUINE|FLAGS?)\b|%/i
export function safeKey(key: string): boolean {
  return key.length > 0 && !UNSAFE_KEY.test(key)
}

export const TOP_PAYEES = 5

export interface RaisedFlag {
  code: string
  check: string
  /** Statement rows the rule pointed at (references only). */
  evidenceRows: number
}

export interface SummaryFacts {
  statements: Array<{ ref: string; bank: string | null; periodStart: string | null; periodEnd: string | null; reconciled: boolean; averageBalance: string | null; lowestBalance: string | null }>
  statementCount: number
  coverageDays: number
  months: Array<{ month: string; moneyIn: string; moneyOut: string; salaryCredits: number }>
  monthCount: number
  moneyInWholePeriod: string
  moneyOutWholePeriod: string
  salaryPayDays: number[]
  uncategorisedPercentOfMoneyOut: number | null
  livingSpendPerMonth: string
  livingSpendPerMonthByCategory: Record<string, string>
  declaredExpensesPerMonth: string | null
  /** Whether living spend is above or below what was declared, so the prose need not infer it from a sign. */
  livingSpendComparedWithDeclared: "above" | "below" | "equal" | null
  livingSpendDifferenceFromDeclaredPerMonth: string | null
  topPayees: Array<{ payee: string; moneyOut: string; payments: number }>
  raisedFlags: RaisedFlag[]
  raisedFlagCount: number
}

export interface Built<F> {
  facts: F
  allowed: Allowed
  raisedFlagCodes: string[]
  /** sha256 over the facts: an output for other facts is stale. */
  inputHash: string
}

export function hashInput(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

/** Collects every figure in a facts object into the post-check's allowed set. */
export function allowedFrom(facts: unknown, extraLiterals: string[] = []): Allowed {
  const amounts: number[] = []
  const percents: number[] = []
  const numbers: number[] = []
  const dates: string[] = []
  const months: string[] = []
  const literals: string[] = [...extraLiterals]
  const visit = (v: unknown, key: string) => {
    if (v === null || v === undefined) return
    if (Array.isArray(v)) return v.forEach((x) => visit(x, key))
    if (typeof v === "object") return Object.entries(v as Record<string, unknown>).forEach(([k, x]) => visit(x, k))
    if (typeof v === "number") return void (/percent/i.test(key) ? percents : numbers).push(v)
    if (typeof v !== "string") return
    const amount = v.match(/^-?R([\d ]+)\.(\d{2})$/)
    if (amount) return void amounts.push(Number(amount[1].replace(/ /g, "")) * 100 + Number(amount[2]))
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return void dates.push(v)
    if (/^\d{4}-\d{2}$/.test(v)) return void months.push(v)
    // Any other string with a digit (a row reference, a code) may be copied whole, never read as a figure.
    if (/\d/.test(v)) literals.push(v)
  }
  visit(facts, "")
  return { amountsCents: amounts, percents, numbers, dates, months, literals }
}

type PayeeRow = Pick<CountedRow, "t">

function topPayees(rows: PayeeRow[]): SummaryFacts["topPayees"] {
  const by = new Map<string, { cents: number; n: number }>()
  for (const { t } of rows) {
    if (t.amountCents >= 0 || t.nonPosting) continue
    const key = labelKey(t.description)
    if (!safeKey(key)) continue
    const e = by.get(key) ?? { cents: 0, n: 0 }
    e.cents -= t.amountCents
    e.n++
    by.set(key, e)
  }
  return [...by.entries()]
    .sort((a, b) => b[1].cents - a[1].cents || a[0].localeCompare(b[0]))
    .slice(0, TOP_PAYEES)
    .map(([payee, e]) => ({ payee, moneyOut: rand(e.cents), payments: e.n }))
}

function evidenceRows(f: Pick<ApplicationCheckFlag, "evidence">): number {
  const e = (f.evidence ?? {}) as Record<string, unknown>
  return Array.isArray(e.transactionIndexes) ? e.transactionIndexes.length : 0
}

/**
 * Feature A's facts. `rows` are the reconciled statements' rows (the ones
 * the insights counted); `flags` the application's OPEN flags.
 */
export function summaryFacts(
  insights: Insights,
  rows: PayeeRow[],
  flags: Array<Pick<ApplicationCheckFlag, "code" | "check" | "evidence">>,
): Built<SummaryFacts> {
  const raised = [...flags].sort((a, b) => a.code.localeCompare(b.code)).map((f) => ({ code: f.code, check: f.check, evidenceRows: evidenceRows(f) }))
  const facts: SummaryFacts = {
    statements: insights.statements.map((s, i) => ({
      ref: `S${i + 1}`,
      bank: s.bank,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      reconciled: s.used,
      averageBalance: s.averageBalanceCents === null ? null : rand(s.averageBalanceCents),
      lowestBalance: s.lowestBalanceCents === null ? null : rand(s.lowestBalanceCents),
    })),
    statementCount: insights.statements.length,
    coverageDays: insights.coverageDays,
    months: insights.months.map((m) => ({ month: m.month, moneyIn: rand(m.inCents), moneyOut: rand(m.outCents), salaryCredits: m.salaryCredits })),
    monthCount: insights.months.length,
    moneyInWholePeriod: rand(insights.months.reduce((t, m) => t + m.inCents, 0)),
    moneyOutWholePeriod: rand(insights.months.reduce((t, m) => t + m.outCents, 0)),
    salaryPayDays: insights.salary.payDays,
    uncategorisedPercentOfMoneyOut: insights.uncategorisedShare === null ? null : pct(insights.uncategorisedShare),
    livingSpendPerMonth: rand(insights.living.monthlyCents),
    livingSpendPerMonthByCategory: Object.fromEntries(Object.entries(insights.living.byCategoryMonthlyCents).map(([k, v]) => [k, rand(v ?? 0)])),
    declaredExpensesPerMonth: insights.declaredCents === null ? null : rand(insights.declaredCents),
    livingSpendComparedWithDeclared: insights.gapCents === null ? null : insights.gapCents > 0 ? "above" : insights.gapCents < 0 ? "below" : "equal",
    livingSpendDifferenceFromDeclaredPerMonth: insights.gapCents === null ? null : rand(Math.abs(insights.gapCents)),
    topPayees: topPayees(rows),
    raisedFlags: raised,
    raisedFlagCount: raised.length,
  }
  const codes = raised.map((f) => f.code)
  return { facts, allowed: allowedFrom(facts, codes), raisedFlagCodes: codes, inputHash: hashInput(facts) }
}

export interface ExplanationFacts {
  flag: { code: string; check: string; whatTheRuleChecks: string; direction: string | null }
  policyThresholds: FlagSpecFacts
  evidence: Record<string, string | number>
  evidenceRows: Array<{ ref: string; date: string; payee: string; amount: string }>
  /** Code's total of the rows listed, so the prose need not add them. */
  evidenceRowsTotal: string | null
}

/**
 * Feature B's facts for one raised flag: its code, what its rule checks,
 * the policy threshold from policy.ts, the evidence figures and the rows the
 * rule pointed at, by reference (S1-R12: statement 1, row 12), payee masked.
 */
export function explanationFacts(
  flag: Pick<ApplicationCheckFlag, "code" | "check" | "evidence">,
  rows: Array<{ statementRef: string; index: number; t: StatementTransaction }>,
  raisedFlagCodes: string[],
): Built<ExplanationFacts> {
  const spec = flagSpec(flag.code, flag.evidence)
  const e = (flag.evidence ?? {}) as Record<string, unknown>
  const evidence: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(e)) {
    if (typeof v === "number" && Number.isFinite(v)) evidence[k] = /Cents$/.test(k) ? rand(v) : v
    else if (typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(v)) evidence[k] = v
  }
  const facts: ExplanationFacts = {
    flag: { code: flag.code, check: flag.check, whatTheRuleChecks: spec.rule, direction: spec.direction === "ABOVE" ? "above what is expected" : spec.direction === "BELOW" ? "below what is expected" : null },
    policyThresholds: spec.thresholds,
    evidence: Object.fromEntries(Object.entries(evidence).map(([k, v]) => [k.replace(/Cents$/, ""), v])),
    evidenceRowsTotal: rows.length ? rand(rows.reduce((t, r) => t + r.t.amountCents, 0)) : null,
    evidenceRows: rows.map((r) => ({ ref: `${r.statementRef}-R${r.index}`, date: r.t.date, payee: safeKey(labelKey(r.t.description)) ? labelKey(r.t.description) : "(payee withheld)", amount: rand(r.t.amountCents) })),
  }
  return {
    facts,
    allowed: allowedFrom(facts, [flag.code, ...raisedFlagCodes]),
    raisedFlagCodes,
    inputHash: hashInput(facts),
  }
}
