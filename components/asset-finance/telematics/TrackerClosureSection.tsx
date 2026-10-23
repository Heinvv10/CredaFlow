import { formatDateTime } from "@/lib/utils"

const subheading = "mb-2 mt-4 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--cf-text-muted)]"
const MESSAGE: Record<string, string> = { SENT: "Email sent", SIMULATED: "Email simulated (not sent)", BLOCKED: "Email not sent", FAILED: "Email failed" }

export interface TrackerClosureView {
  id: string
  externalDeviceId: string
  closedAt: Date
  noticeLoggedAt: Date | null
  messageOutcome: string | null
  messageNote: string | null
  letterGeneratedAt: Date | null
  removedAt: Date | null
}

/**
 * The loan completed with a tracker on its asset (SLICE5-FOLLOWUPS.md part T):
 * the staff task to remove or switch off the device (done when the device is
 * removed, under Tracker devices on the asset), and each notice to the
 * borrower: portal, email and the stored letter. Nothing is told to the
 * borrower until the lender approves the wording (the steps wait, and say so).
 */
export function TrackerClosureSection({ loanId, assetId, closures, wordingApproved }: { loanId: string; assetId: string; closures: TrackerClosureView[]; wordingApproved: boolean }) {
  return (
    <>
      <h3 className={subheading}>Tracking stopped</h3>
      <ul className="space-y-2 text-sm">
        {closures.map((c) => (
          <li key={c.id} className="space-y-0.5 rounded-md border border-[var(--cf-border-subtle)] p-2">
            <p className="text-[var(--cf-text)]">
              <span className="font-mono">{c.externalDeviceId}</span> · loan closed {formatDateTime(c.closedAt)}
            </p>
            <p className={c.removedAt ? "text-[var(--cf-success)]" : "text-[var(--cf-warning)]"}>
              {c.removedAt ? `Device removed ${formatDateTime(c.removedAt)}` : "To do: remove or switch off the device, then mark it removed on the "}
              {!c.removedAt && <a className="text-[var(--cf-brand)] underline-offset-2 hover:underline" href={`/asset-finance/assets/${assetId}`}>asset</a>}
            </p>
            {!wordingApproved && !c.noticeLoggedAt && (
              <p className="text-[var(--cf-warning)]">Held: nothing is told to the borrower until the lender approves the asset-finance wording.</p>
            )}
            <p className="text-[var(--cf-text-secondary)]">
              Portal notice: {c.noticeLoggedAt ? formatDateTime(c.noticeLoggedAt) : "pending"} ·{" "}
              {c.messageOutcome ? <span title={c.messageNote ?? undefined}>{MESSAGE[c.messageOutcome] ?? c.messageOutcome}</span> : "Email pending"} ·{" "}
              {c.letterGeneratedAt ? (
                <a className="text-[var(--cf-brand)] underline-offset-2 hover:underline" target="_blank" rel="noopener noreferrer"
                  href={`/api/asset-finance/loans/${loanId}/telematics/closures/${c.id}/letter`}>Letter</a>
              ) : "Letter pending"}
            </p>
          </li>
        ))}
      </ul>
    </>
  )
}
