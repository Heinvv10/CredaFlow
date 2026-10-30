import type { prisma } from "@/lib/prisma"
import type { UserRole } from "@/lib/permissions"
import { authorityLevel, requiredLevelsFor } from "./evaluate"
import { delegatorLevels, loadDelegationsFor, type StoredMatrix } from "./matrix-store"
import { planApproval, type ApprovalPlan } from "./plan"
import { seatMap } from "./seats"
import type { ApplicationFacts, MatrixLevel } from "./types"

type Db = Pick<typeof prisma, "approvalStep" | "approvalDelegation" | "creditCommitteeDecision" | "user">

export interface AssessedCase {
  requiredLevels: number | null
  matchedRuleIds: string[]
  levelsSnapshot: unknown
}

export interface AssessedStep { level: number; approverId: string; delegationId: string | null }

export interface Assessment {
  /** What the facts now require, never less than the case already holds. */
  required: number
  matchedRuleIds: string[]
  levels: MatrixLevel[]
  steps: AssessedStep[]
  committeeLevel: MatrixLevel | undefined
  committeeRows: Array<{ decision: "APPROVED" | "DECLINED" | "DEFERRED"; conditions: unknown; recordedById: string; delegationId: string | null }>
  authorityLevel: number
  plan: ApprovalPlan
}

/**
 * Where an approval attempt stands, from the data: the requirement (raised when the facts ask for more than the case holds, never
 * lowered), who has approved, the user's authority (a delegation from someone who made the application or already approved it is
 * not used: one person holds one seat) and the plan. The gate and the progress view both read this, so the view cannot promise
 * what the gate refuses.
 */
export async function assessApproval(db: Db, input: {
  tenantId: string
  matrix: StoredMatrix
  theCase: (AssessedCase & { id: string }) | null
  facts: ApplicationFacts
  inputStaffIds: readonly string[]
  user: { id: string; role: string }
  automated: boolean
  now: Date
}): Promise<Assessment> {
  const { tenantId, theCase, facts, user } = input
  const computed = requiredLevelsFor(input.matrix.payload, facts)
  const stored = theCase?.requiredLevels ?? null
  const required = Math.max(stored ?? 0, computed.requiredLevels)
  const matchedRuleIds = stored === null || computed.requiredLevels >= stored ? computed.matchedRuleIds : (theCase?.matchedRuleIds ?? [])
  const levels = (theCase?.levelsSnapshot as MatrixLevel[] | null | undefined) ?? input.matrix.payload.levels
  const steps = theCase ? await db.approvalStep.findMany({ where: { caseId: theCase.id }, select: { level: true, approverId: true, delegationId: true }, orderBy: { level: "asc" } }) : []
  const committeeLevel = levels.find((l) => l.committee)
  const committeeRows = theCase && committeeLevel
    ? await db.creditCommitteeDecision.findMany({ where: { caseId: theCase.id, level: committeeLevel.level }, orderBy: { createdAt: "desc" }, select: { decision: true, conditions: true, recordedById: true, delegationId: true } })
    : []
  // Every act on the case, with the delegator behind it: the seats taken (./seats.ts). A delegation from anyone already seated is not used.
  const delegationIds = [...steps.map((s) => s.delegationId), ...committeeRows.map((d) => d.delegationId)].filter((id): id is string => id !== null)
  const delegators = new Map<string, string>()
  if (delegationIds.length > 0) {
    for (const d of await db.approvalDelegation.findMany({ where: { tenantId, id: { in: delegationIds } }, select: { id: true, delegatorId: true } })) delegators.set(d.id, d.delegatorId)
  }
  const holder = (delegationId: string | null) => (delegationId === null ? null : (delegators.get(delegationId) ?? null))
  const seats = seatMap({
    makerIds: input.inputStaffIds,
    steps: steps.map((s) => ({ actorId: s.approverId, authorityHolderId: holder(s.delegationId) })),
    recorders: committeeRows.map((d) => ({ actorId: d.recordedById, authorityHolderId: holder(d.delegationId) })),
  })
  const delegations = await loadDelegationsFor(db, tenantId, user.id, input.now)
  const caps = await delegatorLevels(db, tenantId, delegations, levels)
  const authorityFor = (list: typeof delegations) => authorityLevel({ role: user.role as UserRole, levels, delegations: list, amountCents: facts.amountCents, now: input.now, delegatorLevels: caps })
  const authority = authorityFor(delegations.filter((d) => !seats.has(d.delegatorId)))
  const plan = planApproval({
    required, levels, steps, seatedAs: seats.get(user.id) ?? null, authority, blockedAuthorityLevel: authorityFor(delegations).level,
    automated: input.automated, committeeDecision: committeeRows[0] ?? null,
  })
  return { required, matchedRuleIds, levels, steps, committeeLevel, committeeRows, authorityLevel: authority.level, plan }
}
