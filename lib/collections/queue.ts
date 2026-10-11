import type { Prisma } from "@prisma/client"
import { COLLECTIONS_ELIGIBLE_STATUSES } from "@/lib/collections/section129-eligibility"

/**
 * The collections queue is a WORK LIST, not a reporting figure, so it uses
 * COLLECTIONS_ELIGIBLE_STATUSES — the population `evaluateCollectionsEligibility`
 * will actually accept — and NOT the collectible book.
 *
 * Widening it to the book put PENDING_WRITE_OFF loans in front of collections
 * officers where every per-loan action (reminder, stage change, arrangement,
 * attorney referral) is refused, and those loans already appear in the
 * pending-write-offs panel on this same page — the same "surface offers work
 * the API rejects" defect this codebase has hit before.
 *
 * The PAR figure in the header is a different question and correctly comes
 * from lib/reports/par.ts, which IS on the collectible book.
 */
/**
 * The collections queue. With default charges live, a loan whose schedule is
 * paid but whose charges are still owed is in arrears too and belongs here
 * (Section 129 eligibility stays schedule-based; see section129-eligibility).
 */
export function collectionsQueueWhere(tenantId: string, chargesLive: boolean): Prisma.LoanWhereInput {
  const overdueOnSchedule = {
    // Only genuinely-overdue accounts — a settled loan with stale DPD but R0
    // arrears must NOT sit in the collections queue.
    daysInArrears: { gt: 0 },
    arrearsAmount: { gt: 0 },
    // A fully-repaid loan carrying stale arrears (arrears > outstanding) must
    // not sit in the collections queue or count toward S129 (audit N-03/N-05).
    outstandingPrincipal: { gt: 0 },
  }
  return {
    tenantId,
    status: { in: [...COLLECTIONS_ELIGIBLE_STATUSES] },
    ...(chargesLive
      ? { OR: [overdueOnSchedule, { chargesOutstanding: { gt: 0 } }] }
      : overdueOnSchedule),
  }
}
