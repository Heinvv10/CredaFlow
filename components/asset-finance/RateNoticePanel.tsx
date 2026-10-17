import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { rateNoticeDispatchStatus } from "@/lib/asset-finance/rate-notice-deadline"

const labels = {
  TIMELY_DISPATCH: "Provider accepted dispatch within the deadline",
  LATE_DISPATCH: "Provider accepted dispatch after the deadline",
  OVERDUE_UNVERIFIED: "Deadline passed; timely dispatch is unverified",
  PENDING: "Dispatch pending",
}

export async function RateNoticePanel({ tenantId, loanId }: { tenantId: string; loanId: string }) {
  const notices = await prisma.assetFinanceRateNotice.findMany({
    where: { tenantId, loanId, statutoryDueOn: { not: null } },
    orderBy: { effectiveDate: "asc" },
  })
  if (!notices.length) return null
  const today = sastCalendarDate(new Date())
  return (
    <section className="rounded-lg border p-4" aria-label="Statutory rate notice deadlines">
      <h2 className="font-semibold">Written rate notice deadlines</h2>
      {notices.map((notice) => {
        const dueOn = isoOfDbDate(notice.statutoryDueOn!)
        const dispatchedOn = notice.firstDispatchedAt ? sastCalendarDate(notice.firstDispatchedAt) : null
        return (
          <div key={notice.id}>
            <p>
              Rate effective {isoOfDbDate(notice.effectiveDate)}; written notice due {dueOn}.
            </p>
            <p>
              {labels[rateNoticeDispatchStatus(dueOn, today, dispatchedOn)]}
              {dispatchedOn ? ` (${dispatchedOn})` : ""}.
            </p>
            {notice.deadlineExceptionAt && (
              <p>Historical deadline escalation retained: {sastCalendarDate(notice.deadlineExceptionAt)}.</p>
            )}
            {!notice.completedAt && <p>The current written notice revision remains pending.</p>}
          </div>
        )
      })}
      <p>
        Provider acceptance records dispatch. Confirm agreed-channel delivery evidence separately; this is not proof
        that the borrower read the notice.
      </p>
    </section>
  )
}
