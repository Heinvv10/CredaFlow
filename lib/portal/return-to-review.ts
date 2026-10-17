import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"

/**
 * When staff last returned this application to review (decide route,
 * action "return_to_review"), from its audit row; null when never. A return
 * voids the agreement and debit mandate the borrower signed, so the portal
 * says why it asks for them again. The staff reason is internal and not read.
 */
export async function lastReturnedToReview(tenantId: string, applicationId: string): Promise<Date | null> {
  const row = await prisma.auditLog.findFirst({
    where: { tenantId, action: AuditAction.APPLICATION_RETURNED_TO_REVIEW, entity: "LoanApplication", entityId: applicationId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  })
  return row?.createdAt ?? null
}
