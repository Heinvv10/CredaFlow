import { addSouthAfricanBusinessDays, isSouthAfricanBusinessDate } from "@/lib/compliance/sa-business-days"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import type { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { alertLoanAdmins } from "./reprice-notice"
import { dbDate, isoOfDbDate, toDayNumber, fromDayNumber } from "./dates"

function warningDate(dueOn: string): string {
  let day = toDayNumber(dueOn),
    remaining = 2
  while (remaining) {
    day--
    if (isSouthAfricanBusinessDate(fromDayNumber(day))) remaining--
  }
  return fromDayNumber(day)
}
export function rateNoticeDeadline(effectiveDate: string) {
  const dueOn = addSouthAfricanBusinessDays(effectiveDate, 30)
  return { dueOn, escalateOn: warningDate(dueOn) }
}
export function deadlineLevel(dueOn: string, today: string, firstDispatchedOn: string | null): number {
  if (firstDispatchedOn && firstDispatchedOn <= dueOn) return 0
  if (today > dueOn) return 3
  if (today === dueOn) return 2
  return today >= warningDate(dueOn) ? 1 : 0
}
/** Dispatch timing is evidence of sending, not proof of agreed-channel receipt. */
export function rateNoticeDispatchStatus(dueOn: string, today: string, firstDispatchedOn: string | null) {
  if (firstDispatchedOn) return firstDispatchedOn <= dueOn ? "TIMELY_DISPATCH" : "LATE_DISPATCH"
  return today > dueOn ? "OVERDUE_UNVERIFIED" : "PENDING"
}

type DeadlineDb = Pick<typeof prisma, "assetFinanceRateNotice" | "$transaction">
/** Scan the durable statutory obligation independently of repricing eligibility,
 * feature flags and dispatch queues. Later dispatch cannot erase the historical uncertainty/escalation record. */
export async function scanRateNoticeDeadlines(db: DeadlineDb, today = sastCalendarDate(new Date())) {
  const notices = await withoutTenantScope(() =>
    db.assetFinanceRateNotice.findMany({ where: { statutoryDueOn: { not: null } } })
  )
  let escalated = 0
  for (const notice of notices) {
    const dueOn = isoOfDbDate(notice.statutoryDueOn!)
    const level = deadlineLevel(
      dueOn,
      today,
      notice.firstDispatchedAt ? sastCalendarDate(notice.firstDispatchedAt) : null
    )
    if (level <= notice.deadlineEscalationLevel) continue
    const changed = await db.$transaction(async (tx) => {
      const update = await tx.assetFinanceRateNotice.updateMany({
        where: {
          id: notice.id,
          tenantId: notice.tenantId,
          taxAdjustmentRevision: notice.taxAdjustmentRevision,
          firstDispatchedAt: notice.firstDispatchedAt,
          deadlineEscalationLevel: notice.deadlineEscalationLevel,
        },
        data: {
          deadlineEscalationLevel: level,
          ...(level === 3 && !notice.deadlineExceptionAt ? { deadlineExceptionAt: dbDate(today) } : {}),
        },
      })
      if (update.count !== 1) return false
      await alertLoanAdmins(tx, notice.tenantId, {
        type: "LOAN_REPRICED",
        title: `${level === 3 ? "Overdue statutory notice" : level === 2 ? "Statutory notice due today" : "Statutory notice due soon"}: ${notice.loanReference}`,
        body: `NCA s104(3) written rate notice was due ${dueOn}, 30 South African business days after the actual effective date ${isoOfDbDate(notice.effectiveDate)}. ${level === 3 ? "Deadline passed without verified timely dispatch. Inspect the actual dispatch and agreed-channel delivery evidence; later evidence does not erase this escalation record." : "Confirm dispatch and agreed-channel delivery evidence for every required recipient."} Inspect missing contacts, template, failed or uncertain outcomes.`,
        entityType: "Loan",
        entityId: notice.loanId,
      })
      await logAuditStrict(
        {
          tenantId: notice.tenantId,
          userEmail: "system@asset-finance-reprice",
          action: AuditAction.ASSET_FINANCE_RATE_NOTICE_DISPATCH,
          entity: "AssetFinanceRateNotice",
          entityId: notice.id,
          newValue: {
            source: "statutory_deadline_scan",
            dueOn,
            level,
            unverifiedDeadlineException: level === 3,
            firstDispatchedAt: notice.firstDispatchedAt?.toISOString() ?? null,
          },
        },
        tx
      )
      return true
    })
    if (changed) escalated++
  }
  return { escalated }
}
