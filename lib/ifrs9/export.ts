/** The loan-level ECL workbook for the Central Bank file: sheets for lib/ifrs9 runs, rows as the reports export writes them (rand, percent). */
import { loadLoanLevel, loadRunReport, type LoanEclRow, type RunReport } from "./run-report"
import type { TransitionEdge } from "./report"

export type ExportRow = Record<string, string | number | boolean | null | undefined>

const rand = (cents: number) => cents / 100
const pct = (bps: number) => bps / 100
const edge = (e: TransitionEdge) => (e === "NEW" ? "New" : e === "CLOSED" ? "Closed" : `Stage ${e}`)

export function eclWorkbookSheets(report: RunReport, loans: readonly LoanEclRow[]): Array<{ name: string; rows: ExportRow[] }> {
  const loanRows = loans.map((l): ExportRow => ({
    Loan: l.reference, "Contract type": l.contractType, Product: l.product, Status: l.loanStatus, "Days past due": l.daysPastDue,
    Stage: l.stage, "Previous stage": l.previousStage, "In stage since": l.stageSince, Reasons: l.reasons.join("; "),
    "Principal (R)": rand(l.outstandingPrincipalCents), "Unpaid interest (R)": rand(l.unpaidInterestCents), "Unpaid fees (R)": rand(l.unpaidFeesCents),
    "Default charges (R)": rand(l.chargesOutstandingCents), "Accrued interest (R)": rand(l.accruedInterestCents),
    "Interest in suspense (R)": rand(l.suspendedInterestCents), "Default interest in suspense (R)": rand(l.suspendedDefaultInterestCents),
    "EAD (R)": rand(l.eadCents), "Parameter scope": l.parameterScope, "PD (%)": pct(l.pdBps), "LGD (%)": pct(l.lgdBps), "ECL (R)": rand(l.eclCents),
  }))
  const totals = (label: string, t: { loans: number; eadCents: number; eclCents: number; coverageBps: number; suspendedCents: number }): ExportRow => ({
    Stage: label, Loans: t.loans, "EAD (R)": rand(t.eadCents), "ECL (R)": rand(t.eclCents), "Coverage (%)": pct(t.coverageBps), "Interest in suspense (R)": rand(t.suspendedCents),
  })
  const summaryRows = [...report.summary.byStage.map((s) => totals(`Stage ${s.stage}`, s)), totals("Total", report.summary.total)]
  const earlier = report.previousRun?.runDate ?? ""
  const transitionRows = (report.transitions?.cells ?? []).map((c): ExportRow => ({
    From: edge(c.from), To: edge(c.to), Loans: c.loans, "Earlier EAD (R)": rand(c.fromEadCents), "Later EAD (R)": rand(c.toEadCents),
    "Earlier run": earlier, "Later run": report.run.runDate,
  }))
  return [
    { name: "Loan ECL", rows: loanRows },
    { name: "Stage summary", rows: summaryRows },
    { name: "Transitions", rows: transitionRows },
  ]
}

/** The workbook sheets for a run (default: the latest, against the one before it), or null when there is no such run. */
export async function buildEclExport(
  db: Parameters<typeof loadRunReport>[0] & Parameters<typeof loadLoanLevel>[0],
  tenantId: string,
  runId?: string,
  compareToRunId?: string,
): Promise<{ report: RunReport; sheets: ReturnType<typeof eclWorkbookSheets> } | null> {
  const report = await loadRunReport(db, tenantId, runId, compareToRunId)
  if (!report) return null
  return { report, sheets: eclWorkbookSheets(report, await loadLoanLevel(db, tenantId, report.run.id)) }
}
