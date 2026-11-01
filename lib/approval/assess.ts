import type { prisma } from "@/lib/prisma"
import type { UserRole } from "@/lib/permissions"
import { authorityLevel, holdsAtBranch, requiredLevelsFor } from "./evaluate"
import { delegatorLevels, loadDelegationsFor, type StoredMatrix } from "./matrix-store"
import { planApproval, type ApprovalPlan } from "./plan"
import { seatMap } from "./seats"
import type { ApplicationFacts, MatrixLevel } from "./types"
import { accountControlRefusal } from "@/lib/security/account-control"

type Db = Pick<typeof prisma, "approvalStep" | "approvalDelegation" | "creditCommitteeDecision" | "user" | "auditLog">

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
    ? await db.creditCommitteeDecision.findMany({ where: { caseId: theCase.id, level: committeeLevel.level }, orderBy: { seq: "desc" }, select: { decision: true, conditions: true, recordedById: true, delegationId: true } })
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
  // A branch-scoped pending level: the person's role, and each delegator's authority, count only at their own branch.
  const pending = levels.find((l) => l.level === steps.length + 1)
  const branches = new Map<string, string | null>()
  if (pending?.branchScoped) {
    for (const u of await db.user.findMany({ where: { tenantId, id: { in: [user.id, ...delegations.map((d) => d.delegatorId)] } }, select: { id: true, branchId: true } })) branches.set(u.id, u.branchId)
  }
  const holds = (id: string) => holdsAtBranch(pending, branches.get(id) ?? null, facts.branchId)
  const authorityFor = (list: typeof delegations, roleCounts = holds(user.id)) => authorityLevel({ role: user.role as UserRole, levels, delegations: list, amountCents: facts.amountCents, now: input.now, delegatorLevels: caps, roleCounts })
  const unseated = delegations.filter((d) => !seats.has(d.delegatorId))
  const authority = authorityFor(unseated.filter((d) => holds(d.delegatorId)))
  let plan = planApproval({
    required, levels, steps, seatedAs: seats.get(user.id) ?? null, authority, blockedAuthorityLevel: authorityFor(delegations.filter((d) => holds(d.delegatorId))).level,
    outOfBranchLevel: authorityFor(unseated, true).level,
    automated: input.automated, committeeDecision: committeeRows[0] ?? null,
  })
  // Two people, not two accounts: nobody already seated on this application created or changed the approver's account, or the reverse.
  if (plan.kind !== "refuse" && plan.level > 0) {
    const controlled = await accountControlRefusal(db, { tenantId, makerIds: [...seats.keys()], checkerId: user.id, now: input.now })
    if (controlled) plan = { kind: "refuse", status: 403, code: "MAKER_ACCOUNT_CONTROLLED", error: controlled }
  }
  return { required, matchedRuleIds, levels, steps, committeeLevel, committeeRows, authorityLevel: authority.level, plan }
}
