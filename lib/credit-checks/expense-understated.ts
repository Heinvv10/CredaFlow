/**
 * EXPENSE_UNDERSTATED: the client's statements show more living spend than
 * the monthly expenses they declared (goal 2026-10-14 §2a.4). Understated
 * expenses overstate what the client can afford, which the NCA affordability
 * assessment rests on. A REFER flag only: categories never change the
 * affordability figure (lib/affordability/ is not involved).
 *
 * Living spend is the categorised spend in living categories
 * (lib/statement-analysis/categories.ts), averaged per month over the
 * reconciling statements' coverage. Own transfers, savings, cash, credit
 * instalments (UNDISCLOSED_DEBT's concern), gambling, fees and anything
 * uncategorised are left out, so a cash-heavy client is never flagged on a guess.
 * A row no rule categorised may carry the local model's label
 * (lib/statement-analysis/model-labels.ts): such rows are named in the
 * evidence as model-assigned, so the officer can check them. The flag only
 * refers; it never declines.
 */
import { CATEGORISER_VERSION } from "@/lib/statement-analysis/categorise"
import { computeInsights } from "@/lib/statement-analysis/insights"
import { formatCents } from "@/lib/statement-analysis/money"
import { understated } from "./policy"
import { statementKey, type ApplicationFacts, type FlagCandidate } from "./types"

export { understated }

export function expenseUnderstated(f: ApplicationFacts): FlagCandidate[] {
  const declared = f.declaredExpensesCents
  if (declared === undefined || declared === null) return []
  const read = f.statements.filter((s) => s.state === "READ" && s.read)
  const insights = computeInsights(
    read.map((s) => ({ documentId: s.documentId, bank: s.bank, balanceCheck: s.balanceCheck, read: s.read!, modelLabels: s.modelLabels })),
    { clientName: f.clientName, declaredExpensesCents: declared },
  )
  if (!insights.enoughCoverage) return []
  if (!understated(insights.living.monthlyCents, declared)) return []
  const gap = insights.living.monthlyCents - declared
  const used = read.filter((s) => s.balanceCheck === "PASS")
  const model = insights.modelAssigned
  return [{
    check: "EXPENSE_UNDERSTATED",
    code: "LIVING_SPEND_ABOVE_DECLARED",
    // The rules that categorised the spend and the figure declared are part of
    // the evidence: new rules, or a declaration edited after a clearance, are a new finding.
    // So are the model's labels: rows it categorised differently are a new finding.
    key: `${CATEGORISER_VERSION}|${declared}|${used.map(statementKey).sort().join(",")}${model.digest ? `|model:${model.digest}` : ""}`,
    summary: `The statements show living spend of about ${formatCents(insights.living.monthlyCents)} a month; ` +
      `the client declared ${formatCents(declared)}, ${formatCents(gap)} less.` +
      (model.livingMonthlyCents > 0 ? ` About ${formatCents(model.livingMonthlyCents)} a month of it is model-assigned: check those rows.` : ""),
    evidence: {
      documentIds: used.map((s) => s.documentId),
      categoriserVersion: CATEGORISER_VERSION,
      months: insights.months.map((m) => m.month),
      coverageDays: insights.coverageDays,
      livingMonthlyCents: insights.living.monthlyCents,
      livingByCategoryMonthlyCents: insights.living.byCategoryMonthlyCents,
      excludedMonthlyCents: insights.living.excludedMonthlyCents,
      declaredCents: declared,
      gapCents: gap,
      ...(model.rowCount > 0 && {
        modelAssigned: { livingMonthlyCents: model.livingMonthlyCents, debitCents: model.debitCents, rowCount: model.rowCount, rows: model.rows },
      }),
    },
  }]
}
