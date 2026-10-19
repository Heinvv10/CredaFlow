import { prisma } from "@/lib/prisma"
import { evaluateCollectionsEligibility, type CollectionsLoanState } from "@/lib/collections/section129-eligibility"

/** Collections stages in which an automated arrears reminder must not go out. */
const HELD_STAGES = ["ATTORNEY_REFERRED", "PAYMENT_ARRANGEMENT", "WRITTEN_OFF"] as const

/** Complaints that are still being handled; RESOLVED and CLOSED are not a dispute. */
const OPEN_COMPLAINT_STATUSES = ["OPEN", "UNDER_INVESTIGATION", "ESCALATED", "ESCALATED_OMBUD"] as const

export type DunningHoldLoan = CollectionsLoanState & {
  clientId: string | null
  collectionsStage: string
}

/**
 * Why an automated arrears reminder must NOT go to this loan's borrower, or
 * null when it may. The same dunning policy as every other collections surface
 * (evaluateCollectionsEligibility), plus the holds it cannot see: a handed-over
 * or arranged account, an open complaint, and a borrower the latest bureau
 * check flags as under debt review.
 */
export async function dunningHoldReason(tenantId: string, loan: DunningHoldLoan): Promise<string | null> {
  const eligibility = evaluateCollectionsEligibility(loan, "DUNNING")
  if (!eligibility.eligible) return `not eligible for collections reminders: ${eligibility.reason}`
  if ((HELD_STAGES as readonly string[]).includes(loan.collectionsStage)) {
    return `collections stage ${loan.collectionsStage}`
  }
  if (loan.clientId === null) return null

  const complaint = await prisma.complaint.findFirst({
    where: { tenantId, clientId: loan.clientId, status: { in: [...OPEN_COMPLAINT_STATUSES] } },
    select: { id: true },
  })
  if (complaint) return "client has an open complaint"

  const bureau = await prisma.creditBureauCheck.findFirst({
    where: { tenantId, clientId: loan.clientId, ok: true },
    orderBy: { createdAt: "desc" },
    select: { underDebtReview: true },
  })
  return bureau?.underDebtReview ? "client is under debt review" : null
}
