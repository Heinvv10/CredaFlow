import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { DebtReviewActions } from "@/components/collections/DebtReviewActions"
import { formatDate } from "@/lib/utils"
import { sastCalendarDate } from "@/lib/date/sast"

/**
 * The loan's debt-review state (NCA s.86). While a notice is recorded no
 * automated reminder reaches the borrower (lib/collections/dunning-holds.ts),
 * and the panel says so. `canManage` shows the record/clear control; the route
 * re-checks the role.
 */
export function DebtReviewPanel({ loanId, noticeAt, noticeRef, canManage }: {
  loanId: string
  noticeAt: Date | null
  noticeRef: string | null
  canManage: boolean
}) {
  // Nothing to show and nothing the viewer can do.
  if (!noticeAt && !canManage) return null

  return (
    <DataPanel
      title="Debt review"
      description="NCA s.86 notice from a debt counsellor"
      variant="default"
      density="loose"
      actions={noticeAt ? <StatusPill tone="warning">Under debt review</StatusPill> : undefined}
    >
      {noticeAt ? (
        <div className="space-y-2 text-sm">
          <div className="flex justify-between gap-4">
            <span className="text-[var(--cf-text-muted)]">Notice received</span>
            <span className="font-medium text-[var(--cf-text)]">{formatDate(noticeAt)}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-[var(--cf-text-muted)]">Counsellor reference</span>
            <span className="font-medium text-[var(--cf-text)]">{noticeRef ?? "Not recorded"}</span>
          </div>
          <p className="text-[var(--cf-text-muted)]">
            Automated reminders to this borrower are paused. Collections actions remain a staff decision.
          </p>
        </div>
      ) : (
        <p className="text-sm text-[var(--cf-text-muted)]">
          No debt-review notice recorded. Record one when a debt counsellor notifies you, and automated reminders stop.
        </p>
      )}
      {canManage && <DebtReviewActions loanId={loanId} recorded={noticeAt !== null} today={sastCalendarDate(new Date())} />}
    </DataPanel>
  )
}
