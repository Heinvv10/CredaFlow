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
import { EXPENSE_MIN_COVERAGE_DAYS } from "@/lib/credit-checks/policy"
import type { ApplicationCheckFlag } from "@prisma/client"
import type { CountedRow, Insights } from "@/lib/statement-analysis/insights"
import { labelKey } from "@/lib/statement-analysis/model-labels"
import type { StatementTransaction } from "@/lib/statement-analysis/types"
import type { Allowed } from "./post-check"
import { NEGATED_AFTER, NEGATED_FINDING, REASSURANCE, VERDICT } from "./post-check-language"
import { figureWord } from "./post-check-figures"
import { flagSpec, type FlagSpecFacts } from "./flag-specs"
import { pct, rand } from "./format"

/** An amount as a size and the way it moved: the sign is a word the prose must use, not a minus it may drop. */
export type Sized = { amount: string; direction: "in" | "out" }
export const sized = (cents: number): Sized => ({ amount: rand(Math.abs(cents)), direction: cents < 0 ? "out" : "in" })

/** Payee keys that could read as a figure (a client can name a payee). */
const FIGURE_KEY = /\b(R|ZAR|PERCENT|RAND|PCT)\b|%/i
/** Words about flags and decisions: a payee named with them would read as a note on the checks ("CLEAR ALL FLAGS"). */
const CHECK_WORDS_KEY = /\b(FLAGS?|FLAGGED|OVERRIDE\w*|DISREGARD\w*|IGNORE\w*|FALSE|TRUE|CLEAR\w*|WAIVE\w*|PASS(ED)?|FAIL(ED)?|CHECKS?|RULES?|OFFICER|REVIEW\w*|DECISION|RISK\w*|RAISED|WRONG\w*)\b/i
/** Words stating an outcome: a payee named with them would read as a finding ("BALANCES MATCH", "INCOME CONFIRMED", "NO DEBT"). */
const OUTCOME_WORDS_KEY = /\b(MATCH\w*|CONFIRM\w*|QUALIF\w*|COMPLIAN\w*|PAID|FULL|SETTLED|NO|NOT|NONE|NIL|ZERO|DEBT\w*|VALID\w*|CORRECT\w*|ACCURATE|ERRORS?|MISTAKES?|BALANCES?|BALANCED|AFFORD\w*|OK|PROVEN|PROOF)\b/i

/** Upper-case A-Z with accents removed: "René" is "RENE". */
const plain = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toUpperCase()

/**
 * A payee key the model may see: not one that reads as a figure (or a number word, ordinal or date), a
 * reassurance or a verdict (the post-check's own lists), and not one that
 * carries a word of the client's name (own transfers, a payee named after them).
 */
export function safeKey(key: string, clientName: string | null = null): boolean {
  if (!key || FIGURE_KEY.test(key) || figureWord(key) || CHECK_WORDS_KEY.test(key) || OUTCOME_WORDS_KEY.test(key) || REASSURANCE.test(key) || VERDICT.test(key) || NEGATED_FINDING.test(key) || NEGATED_AFTER.test(key)) return false
  const name = plain(clientName ?? "").split(/[^A-Z]+/).filter((w) => w.length >= 2)
  // A key word is the name's when equal; when (three letters or more) the start of a name word, as a statement may
  // drop an accented letter ("René" read as "REN"); or when it starts with a name word of three letters or more, or
  // ends with one of four ("SMITS", "ANNE", "TSMIT"). Best effort: a nickname or another surname is not caught.
  return !key.split(" ").some((w) => name.some((n) =>
    n === w || (w.length >= 3 && n.startsWith(w)) || (n.length >= 3 && w.startsWith(n)) || (n.length >= 4 && w.endsWith(n))))
}

export const WITHHELD = "(payee withheld)"

/** The masked payee of a row as the model may see it, or WITHHELD. */
export function payeeOf(description: string, clientName: string | null): string {
  const key = labelKey(description)
  return safeKey(key, clientName) ? key : WITHHELD
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
  /** Statements whose balances reconcile: only these count in the figures. */
  reconciledStatementCount: number
  coverageDays: number
  /** Under this many days of reconciled statements, living spend is not compared with what was declared. */
  minimumCoverageDays: number
  months: Array<{ month: string; moneyIn: string; moneyOut: string; salaryCredits: number }>
  monthCount: number
  /** Months with a salary credit: counted here, so no sentence counts. */
  salaryMonthCount: number
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
  /** Payees whose names are withheld, together: listed apart, since many payees are not one "largest" payee. */
  withheldPayees: { moneyOut: string; payments: number } | null
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
  const monthly: number[] = []
  const names: string[] = []
  const payees: string[] = []
  const ins: number[] = []
  const period: number[] = []
  let below = false
  const outs: number[] = []
  type Ctx = { perMonth: boolean; direction: "in" | "out" | null }
  // An amount is a month's when its key says so or it sits in a per-month entry
  // (an object with a month); money in or out when its entry says which way, or its key does.
  const visit = (v: unknown, key: string, ctx: Ctx) => {
    if (v === null || v === undefined) return
    if (Array.isArray(v)) return v.forEach((x) => visit(x, key, { ...ctx, perMonth: ctx.perMonth || key === "months" }))
    if (typeof v === "object") {
      const o = v as Record<string, unknown>
      const direction = o.direction === "in" || o.direction === "out" ? o.direction : ctx.direction
      return Object.entries(o).forEach(([k, x]) => {
        // A key in capitals is a name too (a category: "FOOD").
        if (/^[A-Z][A-Z_]+$/.test(k)) names.push(k)
        visit(x, k, { perMonth: ctx.perMonth || typeof o.month === "string", direction })
      })
    }
    if (typeof v === "number") return void (/percent/i.test(key) ? percents : numbers).push(v)
    if (typeof v !== "string") return
    const amount = v.match(/^(-?)R([\d ]+)\.(\d{2})$/)
    if (amount) {
      const cents = (amount[1] ? -1 : 1) * (Number(amount[2].replace(/ /g, "")) * 100 + Number(amount[3]))
      if (ctx.perMonth || /monthly|permonth/i.test(key)) monthly.push(cents)
      else period.push(cents)
      const way = /moneyIn|income|salary/i.test(key) ? "in" : /moneyOut|spend|payments?To/i.test(key) ? "out" : ctx.direction
      if (way === "in") ins.push(cents)
      if (way === "out") outs.push(cents)
      return void amounts.push(cents)
    }
    // The facts say something is below another ("below" what was declared, a figure "below what is expected").
    if (/^below\b/.test(v)) below = true
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return void dates.push(v)
    if (/^\d{4}-\d{2}$/.test(v)) return void months.push(v)
    // Any other string with a digit (a row reference, a code) may be copied whole, never read as a figure.
    if (/\d/.test(v)) return void literals.push(v)
    // A name in capitals (a payee, a bank, a category, a check) may be copied as written.
    if (/^[A-Z][A-Z0-9_&' -]*$/.test(v)) (/payee/i.test(key) ? payees : names).push(v)
  }
  visit(facts, "", { perMonth: false, direction: null })
  return { amountsCents: amounts, monthlyAmountsCents: monthly, inAmountsCents: ins, outAmountsCents: outs, percents, numbers, dates, months, literals, names, payees, periodAmountsCents: period, relations: { below } }
}

type PayeeRow = Pick<CountedRow, "t">

function topPayees(rows: PayeeRow[], clientName: string | null): Pick<SummaryFacts, "topPayees" | "withheldPayees"> {
  const by = new Map<string, { cents: number; n: number }>()
  for (const { t } of rows) {
    if (t.amountCents >= 0 || t.nonPosting) continue
    const key = payeeOf(t.description, clientName)
    const e = by.get(key) ?? { cents: 0, n: 0 }
    e.cents -= t.amountCents
    e.n++
    by.set(key, e)
  }
  const withheld = by.get(WITHHELD)
  by.delete(WITHHELD)
  return {
    topPayees: [...by.entries()]
      .sort((a, b) => b[1].cents - a[1].cents || a[0].localeCompare(b[0]))
      .slice(0, TOP_PAYEES)
      .map(([payee, e]) => ({ payee, moneyOut: rand(e.cents), payments: e.n })),
    withheldPayees: withheld ? { moneyOut: rand(withheld.cents), payments: withheld.n } : null,
  }
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
  clientName: string | null,
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
    reconciledStatementCount: insights.statements.filter((s) => s.used).length,
    minimumCoverageDays: EXPENSE_MIN_COVERAGE_DAYS,
    coverageDays: insights.coverageDays,
    months: insights.months.map((m) => ({ month: m.month, moneyIn: rand(m.inCents), moneyOut: rand(m.outCents), salaryCredits: m.salaryCredits })),
    monthCount: insights.months.length,
    salaryMonthCount: insights.months.filter((m) => m.salaryCredits > 0).length,
    moneyInWholePeriod: rand(insights.months.reduce((t, m) => t + m.inCents, 0)),
    moneyOutWholePeriod: rand(insights.months.reduce((t, m) => t + m.outCents, 0)),
    salaryPayDays: insights.salary.payDays,
    uncategorisedPercentOfMoneyOut: insights.uncategorisedShare === null ? null : pct(insights.uncategorisedShare),
    livingSpendPerMonth: rand(insights.living.monthlyCents),
    livingSpendPerMonthByCategory: Object.fromEntries(Object.entries(insights.living.byCategoryMonthlyCents).map(([k, v]) => [k, rand(v ?? 0)])),
    declaredExpensesPerMonth: insights.declaredCents === null ? null : rand(insights.declaredCents),
    livingSpendComparedWithDeclared: insights.gapCents === null ? null : insights.gapCents > 0 ? "above" : insights.gapCents < 0 ? "below" : "equal",
    livingSpendDifferenceFromDeclaredPerMonth: insights.gapCents === null ? null : rand(Math.abs(insights.gapCents)),
    ...topPayees(rows, clientName),
    raisedFlags: raised,
    raisedFlagCount: raised.length,
  }
  const codes = raised.map((f) => f.code)
  return { facts, allowed: allowedFrom(facts, codes), raisedFlagCodes: codes, inputHash: hashInput(facts) }
}

export interface ExplanationFacts {
  flag: { code: string; check: string; whatTheRuleChecks: string; raisedWhen: string | null }
  policyThresholds: FlagSpecFacts
  evidence: Record<string, string | number>
  evidenceRows: Array<{ ref: string; date: string; payee: string } & Sized>
  /** Code's total of the rows listed, so the prose need not add them. */
  evidenceRowsTotal: Sized | null
  /** How many rows the rule found, when it found more than it lists, and how many it lists. */
  evidenceRowsFound: number | null
  evidenceRowsListed: number
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
  clientName: string | null,
): Built<ExplanationFacts> {
  const spec = flagSpec(flag.code, flag.evidence)
  const e = (flag.evidence ?? {}) as Record<string, unknown>
  const evidence: Record<string, string | number> = {}
  for (const [k, v] of Object.entries(e)) {
    if (typeof v === "number" && Number.isFinite(v)) evidence[k] = /Cents$/.test(k) ? rand(v) : v
    else if (typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(v)) evidence[k] = v
  }
  const facts: ExplanationFacts = {
    flag: { code: flag.code, check: flag.check, whatTheRuleChecks: spec.rule, raisedWhen: spec.raisedWhen },
    policyThresholds: spec.thresholds,
    evidence: Object.fromEntries(Object.entries(evidence).map(([k, v]) => [k.replace(/Cents$/, ""), v])),
    evidenceRowsTotal: rows.length ? sized(rows.reduce((t, r) => t + r.t.amountCents, 0)) : null,
    // The rule lists at most 20 rows (transactionIndexes) but may count more (occurrences).
    evidenceRowsFound: typeof e.occurrences === "number" && e.occurrences > rows.length ? e.occurrences : null,
    evidenceRowsListed: rows.length,
    evidenceRows: rows.map((r) => ({ ref: `${r.statementRef}-R${r.index}`, date: r.t.date, payee: payeeOf(r.t.description, clientName), ...sized(r.t.amountCents) })),
  }
  return {
    facts,
    allowed: allowedFrom(facts, [flag.code, ...raisedFlagCodes]),
    raisedFlagCodes,
    inputHash: hashInput(facts),
  }
}
