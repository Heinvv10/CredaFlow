import { prisma } from "@/lib/prisma"

export { DRAFT_AUTOMATED_DECLINE_NOTICE } from "./notice-draft"

/**
 * The paragraph an automated decline's message carries, or null. Only an
 * application the engine itself declined, only once the lender has signed off
 * the automated declines (POPIA s71), and only the wording the lender approved.
 */
export async function automatedDeclineNoticeFor(tenantId: string, applicationId: string): Promise<string | null> {
  const run = await prisma.autoDecisionRun.findFirst({ where: { tenantId, applicationId, execution: "DECLINED" }, select: { id: true } })
  if (!run) return null
  const config = await prisma.decisionEngineConfig.findUnique({ where: { tenantId }, select: { s71SignedOffAt: true, automatedDeclineNotice: true } })
  return config?.s71SignedOffAt && config.automatedDeclineNotice ? config.automatedDeclineNotice : null
}
