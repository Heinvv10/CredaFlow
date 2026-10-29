import { startApplicationReview } from "@/app/api/applications/[id]/review/review-application"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { findSystemUser } from "./system-user"

export type DigitalSubmissionResult =
  | { status: "SKIPPED"; reason: "engine_off" | "mode_off" | "channel_not_enabled" | "product_not_enabled" | "no_system_user" | "application_not_submitted" }
  | { status: "REVIEW_REFUSED"; httpStatus: number }
  | { status: "REVIEWED" }

/**
 * A client submitted an application on a digital channel (the portal or the
 * website): when the lender's engine covers the PORTAL channel for the product,
 * start the review as the lender's system user (the same KYC, mismatch and bureau
 * steps, the same engine) so the decision is not waiting for a person. The review
 * refuses what staff review would refuse (unverified KYC, say); the application then
 * simply stays SUBMITTED for staff. Never throws into a caller: see runDigitalDecision.
 */
export async function reviewDigitalSubmission(input: { tenantId: string; applicationId: string }): Promise<DigitalSubmissionResult> {
  const { tenantId, applicationId } = input
  return runWithTenant(tenantId, async () => {
    const config = await prisma.decisionEngineConfig.findUnique({ where: { tenantId } })
    if (!config) return { status: "SKIPPED", reason: "engine_off" }
    if (config.mode === "OFF") return { status: "SKIPPED", reason: "mode_off" }
    if (!config.channels.includes("PORTAL")) return { status: "SKIPPED", reason: "channel_not_enabled" }
    const application = await prisma.loanApplication.findFirst({ where: { id: applicationId, tenantId }, select: { status: true, productId: true } })
    if (!application || application.status !== "SUBMITTED") return { status: "SKIPPED", reason: "application_not_submitted" }
    if (!config.productIds.includes(application.productId)) return { status: "SKIPPED", reason: "product_not_enabled" }
    const system = await findSystemUser(prisma, tenantId)
    if (!system) return { status: "SKIPPED", reason: "no_system_user" }
    const started = await startApplicationReview({ tenant: { id: tenantId }, user: system, id: applicationId, autoDecisionTrigger: "DIGITAL_SUBMISSION", assignToUser: false })
    return started instanceof Response ? { status: "REVIEW_REFUSED", httpStatus: started.status } : { status: "REVIEWED" }
  })
}
