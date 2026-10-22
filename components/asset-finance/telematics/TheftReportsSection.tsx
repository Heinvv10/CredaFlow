import { positionRefusalFor } from "@/lib/telematics/position-purpose"
import type { TheftReportView } from "@/lib/telematics/theft-reports"
import { formatDateTime } from "@/lib/utils"
import { formatIsoDate } from "@/lib/asset-finance/format"
import { LastKnownPosition } from "./LastKnownPosition"
import { PositionTrail } from "./PositionTrail"
import { TheftReportForm } from "./TheftReportForm"

const subheading = "mb-2 mt-4 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--cf-text-muted)]"

/**
 * A theft reported to SAPS (SLICE5-FOLLOWUPS.md part T): the reports on the
 * loan, a form to record or renew one, and while one is valid the logged
 * latest position and trail for THEFT. Only for view_asset_position (the
 * caller decides); the server refuses everyone else and logs every view.
 */
export async function TheftReportsSection({ tenantId, loanId, reports, running, today }: {
  tenantId: string
  loanId: string
  reports: TheftReportView[]
  running: boolean
  today: string
}) {
  const valid = reports.find((r) => r.valid)
  const latest = reports[0]
  return (
    <>
      <h3 className={subheading}>Theft reported</h3>
      {reports.length === 0 ? <p className="text-sm text-[var(--cf-text-muted)]">No theft reported.</p> : (
        <ul className="space-y-1 text-sm">
          {reports.map((r) => (
            <li key={r.id} className="flex flex-wrap justify-between gap-2">
              <span className="text-[var(--cf-text)]">{r.sapsCaseNumber} · reported {formatIsoDate(r.reportedOn)}</span>
              <span className={r.valid ? "text-[var(--cf-warning)]" : "text-[var(--cf-text-muted)]"}>
                {r.valid ? `Valid until ${formatIsoDate(r.validUntil)}` : `Expired ${formatIsoDate(r.validUntil)}`} · {r.recordedBy} {formatDateTime(r.recordedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {valid ? (
        <div className="mt-3 space-y-3">
          <LastKnownPosition loanId={loanId} context="THEFT" refusal={await positionRefusalFor(tenantId, loanId, "THEFT")} />
          <PositionTrail loanId={loanId} context="THEFT" refusal={await positionRefusalFor(tenantId, loanId, "THEFT")} />
        </div>
      ) : null}
      {running && !valid ? (
        <div className="mt-3"><TheftReportForm loanId={loanId} today={today} renews={latest ? { id: latest.id, sapsCaseNumber: latest.sapsCaseNumber } : undefined} /></div>
      ) : null}
    </>
  )
}
