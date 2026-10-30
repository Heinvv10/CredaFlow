import { prisma } from "@/lib/prisma"
import { canDo, type UserRole } from "@/lib/permissions"
import { assessApproval } from "./assess"
import { loadApplicationForMatrix, loadEffectiveMatrix, loadMatrixVersion } from "./matrix-store"

export interface LevelProgress {
  level: number
  name: string
  role: string
  slaHours: number
  committee: boolean
  state: "APPROVED" | "PENDING" | "WAITING" | "NOT_REQUIRED"
  approvedBy: string | null
  approvedAt: string | null
  via: "ROLE" | "DELEGATION" | null
  conditions: string[]
}

export interface ApprovalProgress {
  /** A matrix is in force or this application has a case: otherwise the application follows the single-approver flow. */
  applies: boolean
  caseId: string | null
  status: "OPEN" | "APPROVED" | "CLOSED" | null
  matrixName: string | null
  matrixVersion: number | null
  requiredLevels: number | null
  /** The requirement is only a preview until the first approval attempt freezes it. */
  requirementFrozen: boolean
  matchedRules: Array<{ id: string; name: string }>
  levels: LevelProgress[]
  pendingLevel: number | null
  dueAt: string | null
  overdue: boolean
  escalationCount: number
  escalations: Array<{ fromLevel: number; toLevel: number; at: string; notified: number }>
  committeeDecisions: Array<{ id: string; decision: string; meetingDate: string; attendees: string[]; conditions: string[]; rationale: string; recordedBy: string; recordedAt: string }>
  viewer: { authorityLevel: number; canApprove: boolean; reason: string | null }
}

const none = (): ApprovalProgress => ({
  applies: false, caseId: null, status: null, matrixName: null, matrixVersion: null, requiredLevels: null, requirementFrozen: false, matchedRules: [], levels: [],
  pendingLevel: null, dueAt: null, overdue: false, escalationCount: 0, escalations: [], committeeDecisions: [], viewer: { authorityLevel: 0, canApprove: false, reason: null },
})

/** Where an application is in its approval chain, and whether the viewer may approve the next level. Read-only. */
export async function loadApprovalProgress(input: { tenantId: string; applicationId: string; viewer: { id: string; role: UserRole }; now?: Date }): Promise<ApprovalProgress> {
  const now = input.now ?? new Date()
  const { tenantId, applicationId } = input
  const application = await loadApplicationForMatrix(prisma, tenantId, applicationId)
  if (!application) return none()
  const theCase = await prisma.approvalCase.findFirst({
    where: { tenantId, applicationId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    include: {
      steps: { orderBy: { level: "asc" }, include: { approver: { select: { name: true, email: true } } } },
      escalations: { orderBy: { createdAt: "asc" } },
    },
  })
  const effective = await loadEffectiveMatrix(prisma, tenantId, now)
  const matrix = theCase?.matrixVersionId ? await loadMatrixVersion(prisma, tenantId, theCase.matrixVersionId) : effective
  if (!matrix || (!theCase && !effective)) return none()
  const assessed = await assessApproval(prisma, {
    tenantId, matrix, theCase, facts: application.facts, inputStaffIds: application.inputStaffIds, user: input.viewer, automated: false, now,
  })
  const { required, levels } = assessed
  const frozen = theCase?.requiredLevels != null
  const matchedIds = assessed.matchedRuleIds
  const steps = theCase?.steps ?? []
  const decisions = theCase
    ? await prisma.creditCommitteeDecision.findMany({ where: { tenantId, caseId: theCase.id }, orderBy: { createdAt: "asc" }, include: { recordedBy: { select: { name: true, email: true } } } })
    : []
  const authority = { level: assessed.authorityLevel }
  // The committee's attendees, rationale and conditions are for those who may read its pack (view_committee_pack).
  const mayReadCommittee = canDo(input.viewer.role, "view_committee_pack")
  const plan = theCase && theCase.status === "OPEN" ? assessed.plan : null
  const pending = theCase?.status === "OPEN" ? steps.length + 1 : null
  return {
    applies: true,
    caseId: theCase?.id ?? null,
    status: theCase?.status ?? null,
    matrixName: matrix.payload.name,
    matrixVersion: matrix.version,
    requiredLevels: required,
    requirementFrozen: frozen,
    matchedRules: matchedIds.map((id) => ({ id, name: matrix.payload.rules.find((r) => r.id === id)?.name ?? id })),
    levels: levels.map((l) => {
      const step = steps.find((s) => s.level === l.level)
      const state: LevelProgress["state"] = step ? "APPROVED" : l.level > required ? "NOT_REQUIRED" : l.level === pending ? "PENDING" : "WAITING"
      return {
        level: l.level, name: l.name, role: l.role, slaHours: l.slaHours, committee: l.committee, state,
        approvedBy: step ? (step.approver.name || step.approver.email) : null, approvedAt: step ? step.createdAt.toISOString() : null, via: step?.via ?? null,
        conditions: mayReadCommittee && Array.isArray(step?.conditions) ? (step!.conditions as string[]) : [],
      }
    }),
    pendingLevel: pending,
    dueAt: theCase?.dueAt?.toISOString() ?? null,
    overdue: Boolean(theCase?.status === "OPEN" && theCase.dueAt && theCase.dueAt < now),
    escalationCount: theCase?.escalationCount ?? 0,
    escalations: (theCase?.escalations ?? []).map((e) => ({ fromLevel: e.fromLevel, toLevel: e.toLevel, at: e.createdAt.toISOString(), notified: e.notifiedUserIds.length })),
    committeeDecisions: (mayReadCommittee ? decisions : []).map((d) => ({
      id: d.id, decision: d.decision, meetingDate: d.meetingDate.toISOString().slice(0, 10), attendees: d.attendees,
      conditions: Array.isArray(d.conditions) ? (d.conditions as string[]) : [], rationale: d.rationale, recordedBy: d.recordedBy.name || d.recordedBy.email, recordedAt: d.createdAt.toISOString(),
    })),
    viewer: {
      authorityLevel: authority.level,
      canApprove: plan !== null && (plan.kind === "record" || plan.kind === "final"),
      reason: plan && plan.kind === "refuse" ? plan.error : null,
    },
  }
}

/** Everyone who approved a level of the application's approval chain (any case): they cannot disburse it while segregation of duties is on. */
export async function approvalStepApproverIds(tenantId: string, applicationId: string): Promise<string[]> {
  const steps = await prisma.approvalStep.findMany({ where: { tenantId, applicationId }, select: { approverId: true } })
  return [...new Set(steps.map((s) => s.approverId))]
}
