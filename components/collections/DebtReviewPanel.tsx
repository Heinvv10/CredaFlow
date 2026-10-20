import Link from "next/link"
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
export function DebtReviewPanel({ loanId, noticeAt, noticeRef, canManage, siblingNotice = null }: {
  loanId: string
  noticeAt: Date | null
  noticeRef: string | null
  canManage: boolean
  /**
   * The client's notice when it is recorded on ANOTHER of their loans. Debt
   * review is consumer-wide, so this loan is held too, and a second notice is
   * not invited here.
   */
  siblingNotice?: { loanId: string; loanReference: string; noticeAt: Date } | null
}) {
  const inherited = noticeAt === null ? siblingNotice : null
  // Nothing to show and nothing the viewer can do.
  if (!noticeAt && !inherited && !canManage) return null

  return (
    <DataPanel
      title="Debt review"
      description="NCA s.86 notice from a debt counsellor"
      variant="default"
      density="loose"
      actions={noticeAt || inherited ? <StatusPill tone="warning">Under debt review</StatusPill> : undefined}
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
      ) : inherited ? (
        <p className="text-sm text-[var(--cf-text-muted)]">
          Debt review is recorded on loan{" "}
          <Link href={`/loans/${inherited.loanId}`} className="font-medium underline">{inherited.loanReference}</Link>
          {" "}(notice received {formatDate(inherited.noticeAt)}). It covers all of this client&apos;s loans, so automated
          reminders are paused here too. Clear it on that loan.
        </p>
      ) : (
        <p className="text-sm text-[var(--cf-text-muted)]">
          No debt-review notice recorded. Record one when a debt counsellor notifies you, and automated reminders stop.
        </p>
      )}
      {canManage && !inherited && <DebtReviewActions loanId={loanId} recorded={noticeAt !== null} today={sastCalendarDate(new Date())} />}
    </DataPanel>
  )
}
