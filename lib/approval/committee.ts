import type { CreditCommitteeDecision } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import type { UserRole } from "@/lib/permissions"
import { committeeProblems, type CommitteeDecisionInput } from "./committee-rules"
import { authorityLevel } from "./evaluate"
import { delegatorLevels, loadDelegationsFor } from "./matrix-store"
import { approversForLevel, notifyStaff } from "./notify"
import type { MatrixLevel } from "./types"

export class CommitteeError extends Error {
  constructor(readonly code: "NO_CASE" | "NOT_AT_COMMITTEE" | "FORBIDDEN" | "INVALID" | "MAKER", readonly status: number, message: string, readonly problems: readonly string[] = []) {
    super(message)
    this.name = "CommitteeError"
  }
}

/**
 * Records what the credit committee decided about an application at its level. Allowed only when every level before the committee's has
 * approved (that is when it meets), by someone holding the committee's authority who did not capture the application. An approval,
 * with its conditions, is what lets the committee level's approver complete the chain (lib/approval/plan.ts); a decline or a deferral
 * blocks it. The latest decision counts; every one stays on the record.
 */
export async function recordCommitteeDecision(input: {
  tenantId: string; actor: { id: string; email: string; role: UserRole }; applicationId: string; decision: CommitteeDecisionInput; now?: Date
}): Promise<CreditCommitteeDecision> {
  const now = input.now ?? new Date()
  const theCase = await prisma.approvalCase.findFirst({ where: { tenantId: input.tenantId, applicationId: input.applicationId, status: "OPEN" } })
  if (!theCase || theCase.requiredLevels === null) throw new CommitteeError("NO_CASE", 409, "This application has no open approval chain that needs the credit committee.")
  const levels = (theCase.levelsSnapshot as unknown as MatrixLevel[]) ?? []
  const committee = levels.find((l) => l.committee)
  if (!committee || committee.level > theCase.requiredLevels) throw new CommitteeError("NO_CASE", 409, "The approval matrix does not send this application to the credit committee.")
  const steps = await prisma.approvalStep.count({ where: { caseId: theCase.id } })
  if (steps + 1 !== committee.level) throw new CommitteeError("NOT_AT_COMMITTEE", 409, `The committee decides at level ${committee.level}; the application is awaiting level ${steps + 1}.`)
  const application = await prisma.loanApplication.findFirst({ where: { id: input.applicationId, tenantId: input.tenantId }, select: { appliedAmount: true, inputStaffIds: true } })
  if (!application) throw new CommitteeError("NO_CASE", 404, "Application not found.")
  if (application.inputStaffIds.includes(input.actor.id)) throw new CommitteeError("MAKER", 403, "You captured this application or changed its figures, so you cannot record its committee decision.")
  const delegations = await loadDelegationsFor(prisma, input.tenantId, input.actor.id, now)
  const authority = authorityLevel({ role: input.actor.role, levels, delegations, amountCents: application.appliedAmount, now, delegatorLevels: await delegatorLevels(prisma, input.tenantId, delegations, levels) })
  if (authority.level < committee.level) throw new CommitteeError("FORBIDDEN", 403, `Recording the committee's decision needs level ${committee.level} authority (${committee.role}).`)
  const problems = committeeProblems(input.decision, now)
  if (problems.length > 0) throw new CommitteeError("INVALID", 422, problems[0], problems)
  return prisma.$transaction(async (tx) => {
    const created = await tx.creditCommitteeDecision.create({
      data: {
        tenantId: input.tenantId, caseId: theCase.id, applicationId: input.applicationId, level: committee.level, decision: input.decision.decision,
        meetingDate: new Date(`${input.decision.meetingDate}T00:00:00Z`), attendees: input.decision.attendees.map((a) => a.trim()),
        conditions: input.decision.conditions.map((c) => c.trim()), rationale: input.decision.rationale.trim(), recordedById: input.actor.id,
      },
    })
    await logAuditStrict({
      tenantId: input.tenantId, userId: input.actor.id, userEmail: input.actor.email, action: AuditAction.COMMITTEE_DECISION_RECORDED,
      entity: "LoanApplication", entityId: input.applicationId,
      newValue: { caseId: theCase.id, level: committee.level, decision: input.decision.decision, conditions: input.decision.conditions.length, attendees: input.decision.attendees.length },
    }, tx)
    if (input.decision.decision === "APPROVED") {
      const recipients = await approversForLevel(tx, { tenantId: input.tenantId, levels, level: committee.level, amountCents: application.appliedAmount, exclude: [...application.inputStaffIds, input.actor.id], now })
      await notifyStaff(tx, { tenantId: input.tenantId, userIds: recipients, type: "COMMITTEE_APPROVED", title: "Credit committee approved: final approval needed", body: "The committee's decision is recorded; the final approval completes the chain.", applicationId: input.applicationId })
    }
    return created
  })
}
