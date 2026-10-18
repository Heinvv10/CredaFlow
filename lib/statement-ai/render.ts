/**
 * Every sentence an officer reads is written here, by code, from the facts or
 * a query's result (Hein, 2026-10-17: structured outputs). The model only
 * chooses: which summary claims, in what order (feature A), and which typed
 * queries answer a question (feature C). Flag explanations (B) use no model.
 * So no wording can reverse a flag, minimise it or hedge it: the words are
 * fixed, and the figures are the facts' own strings. The post-check still runs
 * over the rendered text, as a second line.
 */
import { z } from "zod"
import type { ExplanationFacts, Sized, SummaryFacts } from "./facts"
import type { QueryResult } from "./ask/tools"
import { breakdownTitle, describeFilter, quoted } from "./words"

// ── Feature A: summary claims ───────────────────────────────────────────────

export const SUMMARY_CLAIMS = [
  "coverage", "money", "months", "balances", "salary", "living", "categories", "uncategorised", "payees", "flags",
] as const
export type SummaryClaim = (typeof SUMMARY_CLAIMS)[number]

/** What each claim says, for the model choosing them. */
export const CLAIM_DESCRIPTIONS: Record<SummaryClaim, string> = {
  coverage: "the period the statements cover, in days and statements",
  money: "money in and money out over the whole period",
  months: "money in and out for each month",
  balances: "average and lowest balance for each statement",
  salary: "in how many months a salary credit was found, and on which days",
  living: "living spend a month against the expenses the client declared",
  categories: "living spend a month by category",
  uncategorised: "the share of money out with no category",
  payees: "the largest payees by money out",
  flags: "which credit-check flags the rules raised",
}

export const ClaimsSchema = z.object({ claims: z.array(z.enum(SUMMARY_CLAIMS)).min(1).max(SUMMARY_CLAIMS.length) }).strict()

const list = (items: string[]) => items.join("; ")
const sized = (s: Sized) => `${s.amount} ${s.direction === "in" ? "in" : "out"}`

function claimSentence(claim: SummaryClaim, f: SummaryFacts): string | null {
  switch (claim) {
    case "coverage": {
      const counted = f.statements.filter((s) => s.reconciled)
      const starts = counted.map((s) => s.periodStart).filter((d): d is string => !!d).sort()
      const ends = counted.map((s) => s.periodEnd).filter((d): d is string => !!d).sort()
      const span = starts.length && ends.length ? ` from ${starts[0]} to ${ends[ends.length - 1]}` : ""
      const which = f.reconciledStatementCount === f.statementCount
        ? `${f.statementCount} statement${f.statementCount === 1 ? "" : "s"}, all reconciled`
        : `${f.statementCount} statements, of which ${f.reconciledStatementCount} reconcile and count in the figures`
      return `The reconciled statements cover ${f.coverageDays} days${span}, across ${which}.`
    }
    case "money":
      return `Over the period, money in was ${f.moneyInWholePeriod} and money out was ${f.moneyOutWholePeriod}.`
    case "months":
      return f.months.length ? `By month: ${list(f.months.map((m) => `${m.month} money in ${m.moneyIn}, money out ${m.moneyOut}`))}.` : null
    case "balances": {
      const rows = f.statements.map((s) => s.reconciled
        ? `${s.ref}${s.bank ? ` (${s.bank})` : ""} average balance ${s.averageBalance ?? "unknown"}, lowest balance ${s.lowestBalance ?? "unknown"}`
        : `${s.ref}${s.bank ? ` (${s.bank})` : ""} is not reconciled and is left out of the figures`)
      return rows.length ? `Balances: ${list(rows)}.` : null
    }
    case "salary": {
      if (f.salaryMonthCount === 0) return "No salary credit was found on the statements."
      return `A salary credit was found in ${f.salaryMonthCount} of ${f.monthCount} months, on day ${[...new Set(f.salaryPayDays)].sort((a, b) => a - b).join(", ")} of the month.`
    }
    case "living":
      if (f.declaredExpensesPerMonth === null) return `Living spend is ${f.livingSpendPerMonth} a month; no monthly expenses were declared.`
      if (f.livingSpendComparedWithDeclared === null) {
        return `Living spend is ${f.livingSpendPerMonth} a month, from ${f.coverageDays} days of reconciled statements; that is under the ${f.minimumCoverageDays} days needed, so it is not compared with the declared ${f.declaredExpensesPerMonth}.`
      }
      if (f.livingSpendComparedWithDeclared === "equal") return `Living spend is ${f.livingSpendPerMonth} a month, the same as the declared ${f.declaredExpensesPerMonth}.`
      return `Living spend is ${f.livingSpendPerMonth} a month, ${f.livingSpendDifferenceFromDeclaredPerMonth} ${f.livingSpendComparedWithDeclared} the declared ${f.declaredExpensesPerMonth} a month.`
    case "categories": {
      const rows = Object.entries(f.livingSpendPerMonthByCategory).map(([c, v]) => `${c} ${v}`)
      return rows.length ? `Living spend a month by category: ${list(rows)}.` : null
    }
    case "uncategorised":
      return f.uncategorisedPercentOfMoneyOut === null ? null : `${f.uncategorisedPercentOfMoneyOut}% of money out has no category.`
    case "payees": {
      const payments = (n: number) => `${n} payment${n === 1 ? "" : "s"}`
      const withheld = f.withheldPayees ? `Payees whose names are withheld, together: ${f.withheldPayees.moneyOut} (${payments(f.withheldPayees.payments)}).` : ""
      if (!f.topPayees.length) return withheld || null
      const named = `Largest ${withheld ? "named " : ""}payees by money out: ${list(f.topPayees.map((p) => `${quoted(p.payee)} ${p.moneyOut} (${payments(p.payments)})`))}.`
      return withheld ? `${named}\n${withheld}` : named
    }
    case "flags":
      return f.raisedFlags.length
        ? `Flags raised by the credit checks: ${list(f.raisedFlags.map((r) => `${r.code} (${r.check}, ${r.evidenceRows} evidence row${r.evidenceRows === 1 ? "" : "s"})`))}.\nAn officer reviews each before a decision.`
        : "The credit checks raised no flags."
  }
}

/**
 * The summary from the model's chosen claims, in its order, duplicates
 * dropped, one claim a line (the card lists them). The flags claim is always included when a flag is raised: a summary
 * must never leave out what the rules found.
 */
export function renderSummary(claims: SummaryClaim[], facts: SummaryFacts): string {
  const chosen = [...new Set(claims)]
  if (facts.raisedFlags.length > 0 && !chosen.includes("flags")) chosen.push("flags")
  return chosen.map((c) => claimSentence(c, facts)).filter((s): s is string => !!s).join("\n")
}

// ── Feature B: flag explanations (no model) ─────────────────────────────────

const THRESHOLD_LABELS: Record<string, (v: string | number) => string> = {
  gamblingShareOfIncomePercent: (v) => `betting of at least ${v}% of monthly income`,
  minimumGap: (v) => `a gap of more than ${v} a month`,
  minimumGapShareOfDeclaredPercent: (v) => `and more than ${v}% of what was declared`,
  amountTolerancePercent: (v) => `an amount tolerance of ${v}%`,
  amountTolerance: (v) => `or ${v}, whichever is larger`,
  payDateWindowDays: (v) => `a pay date window of ${v} days`,
  instalmentMatchTolerancePercent: (v) => `an instalment match tolerance of ${v}%`,
  maximumAgeDays: (v) => `a statement ending more than ${v} days before the application`,
  toleranceSeconds: (v) => `a modification more than ${v} seconds after creation`,
}

const EVIDENCE_LABELS: Record<string, string> = {
  monthly: "amount a month", monthlyIncome: "monthly income", occurrences: "number of rows", netPay: "payslip net pay",
  credit: "credit found", livingMonthly: "living spend a month", coverageDays: "days covered", expectedDate: "pay date looked at",
  month: "month", periodEnd: "statement end date",
}

/** One flag's explanation, written from its facts. */
export function renderExplanation(f: ExplanationFacts): string {
  const parts = [`${f.flag.code} (${f.flag.check}): ${f.flag.whatTheRuleChecks}`]
  if (f.flag.raisedWhen) parts.push(f.flag.raisedWhen)
  const thresholds = Object.entries(f.policyThresholds).map(([k, v]) => THRESHOLD_LABELS[k]?.(v)).filter((s): s is string => !!s)
  if (thresholds.length) parts.push(`Policy threshold: ${thresholds.join(", ")}.`)
  const evidence = Object.entries(f.evidence).filter(([k]) => EVIDENCE_LABELS[k]).map(([k, v]) => `${EVIDENCE_LABELS[k]} ${v}`)
  if (evidence.length) parts.push(`Evidence: ${list(evidence)}.`)
  if (f.evidenceRows.length) {
    if (f.evidenceRowsFound !== null) parts.push(`The rule found ${f.evidenceRowsFound} rows; the first ${f.evidenceRowsListed} are listed.`)
    parts.push(`Evidence rows: ${list(f.evidenceRows.map((r) => `${r.ref} ${r.date} ${quoted(r.payee)} ${sized(r)}`))}.`)
    if (f.evidenceRowsTotal && f.evidenceRows.length > 1) parts.push(`The listed rows total ${sized(f.evidenceRowsTotal)}.`)
  }
  parts.push("An officer reviews the flag before a decision.")
  return parts.join(" ")
}

// ── Feature C: query results ────────────────────────────────────────────────

const rowsWord = (n: unknown) => `${n} row${n === 1 ? "" : "s"}`

/** One query's result as a sentence, labelled with its id; the filter shown as the filter, never as a result. */
export function renderResult(q: QueryResult): string {
  const what = describeFilter(q.args)
  const r = q.result as Record<string, unknown>
  switch (q.tool) {
    case "sum":
      return `[${q.id}] ${r.direction ? "Total" : "Net total (a minus means more went out than came in)"} for ${what}: ${r.total}, from ${rowsWord(r.rowCount)}.`
    case "count":
      return `[${q.id}] Rows for ${what}: ${r.count}.`
    case "average":
      return r.average === null
        ? `[${q.id}] No rows for ${what}.`
        : `[${q.id}] ${r.direction ? "Average amount" : "Net average amount (money in less money out, per row; a minus means more went out than came in)"} for ${what}: ${r.average}, over ${rowsWord(r.rowCount)}.`
    case "groupByMonth":
    case "groupByPayee": {
      const key = q.tool === "groupByMonth" ? "month" : "payee"
      const entries = q.result as Array<Record<string, unknown>>
      const items = entries.map((e) => `${key === "payee" ? quoted(e[key]) : e[key]} ${e.total !== undefined ? `${e.total} (${rowsWord(e.rowCount)})` : rowsWord(e.count)}`)
      return items.length ? `[${q.id}] ${breakdownTitle(q)}: ${list(items)}.` : `[${q.id}] No rows for ${what}.`
    }
    case "list": {
      const items = (q.result as Array<Record<string, unknown>>).map((e) => `${e.ref} ${e.date} ${quoted(e.payee)} ${e.amount} ${e.direction}`)
      return items.length ? `[${q.id}] ${breakdownTitle(q)}: ${list(items)}${q.matchedRows > items.length ? `; ${q.matchedRows} rows match in all` : ""}.` : `[${q.id}] No rows for ${what}.`
    }
  }
}

export function renderAnswer(results: QueryResult[]): string {
  return results.map(renderResult).join(" ")
}
