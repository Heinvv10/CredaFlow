import { prisma } from "@/lib/prisma"

export { DRAFT_AUTOMATED_DECLINE_NOTICE } from "./notice-draft"

/**
 * The paragraph an automated decline's message carries, or null. Only an
 * application whose CURRENT decline is the engine's (its decider is the lender's
 * system user), and only the wording that was approved when the engine declined
 * it (stored on the run), never a later edit and never an earlier engine decline
 * a person has since replaced.
 */
export async function automatedDeclineNoticeFor(tenantId: string, applicationId: string): Promise<string | null> {
  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    select: { status: true, approvedBy: { select: { isSystem: true } } },
  })
  if (application?.status !== "DECLINED" || application.approvedBy?.isSystem !== true) return null
  const run = await prisma.autoDecisionRun.findFirst({
    where: { tenantId, applicationId, execution: "DECLINED" },
    orderBy: { createdAt: "desc" },
    select: { noticeText: true },
  })
  return run?.noticeText ?? null
}
