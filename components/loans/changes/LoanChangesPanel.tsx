import Link from "next/link"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { LOAN_CHANGE_LABELS, type LoanChangeType } from "@/lib/loan-changes/types"
import type { LoanChangesView } from "@/lib/loan-changes/view"
import { formatDate, formatDateTime, formatZAR } from "@/lib/utils"
import { ChangeRequestCard } from "./ChangeRequestCard"
import { ProposeChangeForm } from "./ProposeChangeForm"

type Superseded = Array<{ loanId: string; rows: Array<{ id: string; installmentNo: number; dueDate: string; principalDue: number; interestDue: number; feesDue: number; totalDue: number; totalPaid: number }> }>

function AppliedChange({ change, loanId }: { change: LoanChangesView["applied"][number]; loanId: string }) {
  const schedules = change.scheduleBefore as Superseded
  const link = change.newLoanId && change.newLoanId !== loanId ? change.newLoanId : change.newLoanId === loanId ? change.loanId : null
  return (
    <details className="rounded border border-[var(--cf-border-subtle)] p-3 text-sm">
      <summary className="cursor-pointer font-medium text-[var(--cf-text)]">
        {LOAN_CHANGE_LABELS[change.type as LoanChangeType]}, {formatDateTime(change.appliedAt)}
        {change.restructured && <StatusPill tone="warning" className="ml-2">Restructured</StatusPill>}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-[var(--cf-text-muted)]">{change.reason}</p>
        <p className="text-xs text-[var(--cf-text-muted)]">Proposed by {change.maker}, approved by {change.checker}.</p>
        {change.settledCents > 0 && <p className="text-xs text-[var(--cf-text-muted)]">Settled {formatZAR(change.settledCents)}{change.newMoneyCents > 0 ? `, new money ${formatZAR(change.newMoneyCents)}` : ""}.</p>}
        {link && <Link className="text-xs font-medium underline" href={`/loans/${link}`}>{change.newLoanId === loanId ? "The loan this replaced" : "The new loan"}</Link>}
        {schedules.map((schedule) => (
          <div key={schedule.loanId} className="overflow-auto">
            <p className="text-xs font-medium">The schedule it replaced</p>
            <table className="mt-1 w-full min-w-[420px] text-xs">
              <thead className="text-left text-[var(--cf-text-muted)]">
                <tr>{["#", "Due", "Principal", "Total", "Paid"].map((h) => <th key={h} className="pr-2 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody>
                {schedule.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="pr-2">{row.installmentNo}</td>
                    <td className="whitespace-nowrap pr-2">{formatDate(row.dueDate)}</td>
                    <td className="whitespace-nowrap pr-2">{formatZAR(row.principalDue)}</td>
                    <td className="whitespace-nowrap pr-2">{formatZAR(row.totalDue)}</td>
                    <td className="whitespace-nowrap pr-2">{formatZAR(row.totalPaid)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </details>
  )
}

/**
 * Rescheduling, restructuring, top-up, refinance, consolidation, payment holidays, rate and term changes. `view` is null on a
 * loan that cannot have any (`reason` says why): nothing else is shown there.
 */
export function LoanChangesPanel({ loanId, reference, view, reason }: { loanId: string; reference: string; view: LoanChangesView | null; reason: string }) {
  if (!view) {
    return (
      <DataPanel title="Loan changes" description="Restructure, top-up, refinance and more" variant="subtle">
        <p className="text-sm text-[var(--cf-text-muted)]">{reason}</p>
      </DataPanel>
    )
  }
  const refusal = view.inPlaceRefusal && view.newLoanRefusal ? view.newLoanRefusal : null
  const pending = view.requests.filter((r) => r.status === "DRAFT" || r.status === "SUBMITTED")
  const decided = view.requests.filter((r) => r.status === "REJECTED" || r.status === "WITHDRAWN")
  return (
    <DataPanel
      title="Loan changes"
      description="A change is proposed by one person and applied only when a second approves it"
      variant="default"
      actions={view.restructuredAt ? <StatusPill tone="warning">Restructured {formatDate(view.restructuredAt)}</StatusPill> : undefined}
    >
      <div className="space-y-4">
        {pending.map((request) => <ChangeRequestCard key={request.id} request={request} />)}
        {view.canPropose && !refusal && pending.length === 0 && <ProposeChangeForm loanId={loanId} reference={reference} view={view} />}
        {refusal && <p className="text-sm text-[var(--cf-text-muted)]">{refusal}</p>}
        {view.inPlaceRefusal && !view.newLoanRefusal && <p className="text-xs text-[var(--cf-text-muted)]">{view.inPlaceRefusal}</p>}
        {view.terms.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">Terms history</h3>
            <table className="mt-1 w-full text-xs">
              <thead className="text-left text-[var(--cf-text-muted)]"><tr>{["#", "Rate", "Repayment", "Instalments", "Recorded"].map((h) => <th key={h} className="pr-2 font-medium">{h}</th>)}</tr></thead>
              <tbody>
                {view.terms.map((t) => (
                  <tr key={t.sequence}>
                    <td className="pr-2">{t.sequence}</td>
                    <td className="pr-2">{(t.interestRatePm * 100).toFixed(2)}%</td>
                    <td className="pr-2">{t.frequency ? `${t.frequency.toLowerCase()}${t.graceKind === "FULL" ? `, ${t.graceInstalments} skipped` : ""}` : "as written"}</td>
                    <td className="pr-2">{t.instalments ?? "-"}</td>
                    <td className="whitespace-nowrap pr-2">{formatDate(t.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {view.applied.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">Applied changes</h3>
            {view.applied.map((change) => <AppliedChange key={change.id} change={change} loanId={loanId} />)}
          </div>
        )}
        {decided.map((request) => <ChangeRequestCard key={request.id} request={request} />)}
      </div>
    </DataPanel>
  )
}
