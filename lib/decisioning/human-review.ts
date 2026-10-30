import { randomUUID } from "node:crypto"
import type { Prisma } from "@prisma/client"
import { returnAffordabilityToReview } from "@/lib/affordability/snapshot"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { openApprovalCaseSafely } from "@/lib/approval/chain"
import { recordDecisions } from "@/lib/learning-loop/decision-log"
import { consumerReturnRecord } from "@/lib/learning-loop/records"
import { prisma } from "@/lib/prisma"

export const HUMAN_REVIEW_REASON_MIN_LENGTH = 10

export type HumanReviewErrorCode = "NOT_FOUND" | "NOT_DECLINED" | "NOT_AUTOMATED" | "REASON_REQUIRED"

const STATUS: Record<HumanReviewErrorCode, number> = { NOT_FOUND: 404, NOT_DECLINED: 409, NOT_AUTOMATED: 409, REASON_REQUIRED: 400 }

export class HumanReviewError extends Error {
  readonly status: number
  constructor(readonly code: HumanReviewErrorCode, message: string) {
    super(message)
    this.name = "HumanReviewError"
    this.status = STATUS[code]
  }
}

/**
 * A client's right to have a person look again at a decision no person took
 * (POPIA s71): reopens an application the engine declined to UNDER_REVIEW,
 * as staff would on a return to review, so a person decides it afresh. Only a
 * decline that is the engine's NOW can be reopened (the application's decider is
 * the lender's system user): one a person took after an earlier engine decline is
 * a person's decision. The reopening starts a fresh review cycle (new bureau
 * generation, reckless-lending attestation cleared) and marks the application so
 * the engine never decides it again. The automatic decline stays in the record
 * (decision log, audit, run); nothing is deleted.
 */
export async function requestHumanReview(input: {
  tenantId: string
  applicationId: string
  actor: { id: string; email: string; role: string }
  reason: string
}): Promise<void> {
  const reason = input.reason.trim()
  if ([...reason].length < HUMAN_REVIEW_REASON_MIN_LENGTH) {
    throw new HumanReviewError("REASON_REQUIRED", `Say why a person should review it, in at least ${HUMAN_REVIEW_REASON_MIN_LENGTH} characters.`)
  }
  await prisma.$transaction(async (tx) => {
    const application = await tx.loanApplication.findFirst({
      where: { id: input.applicationId, tenantId: input.tenantId },
      select: { id: true, status: true, clientId: true, approvedById: true, approvedBy: { select: { isSystem: true } }, humanReviewRequestedAt: true, affordabilityResult: true },
    })
    if (!application) throw new HumanReviewError("NOT_FOUND", "Application not found")
    if (application.status !== "DECLINED") throw new HumanReviewError("NOT_DECLINED", "Only a declined application can be reopened for review")
    if (application.approvedBy?.isSystem !== true) throw new HumanReviewError("NOT_AUTOMATED", "A person made the current decision; it is not an automated decline")
    const run = await tx.autoDecisionRun.findFirst({
      where: { tenantId: input.tenantId, applicationId: input.applicationId, execution: "DECLINED" },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    })
    if (!run || (application.humanReviewRequestedAt && run.createdAt <= application.humanReviewRequestedAt)) {
      throw new HumanReviewError("NOT_AUTOMATED", "There is no automated decline newer than the last human review of this application")
    }
    const now = new Date()
    const changed = await tx.loanApplication.updateMany({
      where: { id: input.applicationId, tenantId: input.tenantId, status: "DECLINED", approvedById: application.approvedById },
      data: {
        status: "UNDER_REVIEW", approvedById: null, approvedAt: null, decisionReason: null, declineCategory: null, declineInternalNote: null,
        assignedToId: input.actor.id,
        // A new review cycle, as a return to review has (decide-application.ts): evidence tied to the old one does not carry over.
        // Not reset here, because a declined application never had them: the PASQ, agreement and debit-mandate fields belong to an
        // approval (CHECK LoanApplication_approved_status_requires_pasq), so they are null on a decline by construction.
        bureauReviewGeneration: randomUUID(),
        recklessLendingAssessed: false, recklessLendingAssessedById: null, recklessLendingAssessedAt: null,
        bureauOverrideReason: null, bureauOverrideById: null, bureauOverrideAt: null,
        repaymentMethod: null, approvedAmount: null, approvedTermDays: null, approvedRate: null,
        affordabilityResult: returnAffordabilityToReview(application.affordabilityResult) as unknown as Prisma.InputJsonValue,
        humanReviewRequestedAt: now,
      },
    })
    if (changed.count !== 1) throw new HumanReviewError("NOT_DECLINED", "The application changed first; refresh and try again")
    await logAuditStrict({
      tenantId: input.tenantId, userId: input.actor.id, userEmail: input.actor.email, action: AuditAction.AUTO_DECISION_HUMAN_REVIEW_REQUESTED,
      entity: "LoanApplication", entityId: input.applicationId, oldValue: { status: "DECLINED" }, newValue: { status: "UNDER_REVIEW", runId: run.id, reason },
    }, tx)
    await recordDecisions(tx, [consumerReturnRecord({
      tenantId: input.tenantId, applicationId: input.applicationId, clientId: application.clientId, actor: { userId: input.actor.id, role: input.actor.role },
      decidedAt: now, to: "REVIEW", priorStatus: "DECLINED",
    })])
  })
  // A person's review of the application is an approval chain with its clock, like any review that starts.
  await openApprovalCaseSafely({ tenantId: input.tenantId, applicationId: input.applicationId })
}
