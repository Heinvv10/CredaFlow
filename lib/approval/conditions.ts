import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isCheckViolation } from "@/lib/disbursement/guard-violation"
import type { UserRole } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import { accountControlRefusal } from "@/lib/security/account-control"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"

/**
 * The credit committee's conditions, once an application is approved. A condition rides on the approval step (lib/approval/chain.ts); each
 * needs a clearance before the borrower signs and before the loan is paid out. The database refuses the same writes
 * (guardLoanApplicationCommitteeConditions), whichever path makes them: this is the readable refusal, and the list staff work from.
 */
export interface ConditionState {
  index: number
  text: string
  cleared: { by: string; at: string; note: string; byId: string } | null
}

type Db = Pick<typeof prisma, "approvalCase" | "approvalStep" | "approvalConditionClearance">

export class ConditionError extends Error {
  constructor(readonly code: "NO_CONDITION" | "ALREADY_CLEARED" | "MAKER" | "ACCOUNT_CONTROLLED" | "INVALID" | "TOTP_REQUIRED", readonly status: number, message: string) {
    super(message)
    this.name = "ConditionError"
  }
}

/** The application's latest approved case: an earlier approval that was sent back has no say (database: committeeConditionsCase). */
async function currentCase(db: Pick<Db, "approvalCase">, tenantId: string, applicationId: string) {
  return db.approvalCase.findFirst({ where: { tenantId, applicationId, status: "APPROVED" }, orderBy: [{ completedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }], select: { id: true } })
}

/** The conditions of the application's approval, in level order, each with its clearance. */
export async function loadConditions(db: Db, tenantId: string, applicationId: string): Promise<{ caseId: string | null; conditions: ConditionState[] }> {
  const theCase = await currentCase(db, tenantId, applicationId)
  if (!theCase) return { caseId: null, conditions: [] }
  const steps = await db.approvalStep.findMany({ where: { caseId: theCase.id }, orderBy: { level: "asc" }, select: { conditions: true } })
  const texts = steps.flatMap((s) => (Array.isArray(s.conditions) ? (s.conditions as string[]) : []))
  if (texts.length === 0) return { caseId: theCase.id, conditions: [] }
  const rows = await db.approvalConditionClearance.findMany({ where: { caseId: theCase.id }, include: { clearedBy: { select: { name: true, email: true } } } })
  const conditions = texts.map((text, index) => {
    const row = rows.find((r) => r.conditionIndex === index)
    return { index, text, cleared: row ? { by: row.clearedBy.name || row.clearedBy.email, at: row.createdAt.toISOString(), note: row.note, byId: row.clearedById } : null }
  })
  return { caseId: theCase.id, conditions }
}

/** Why the agreement cannot be signed or the loan paid out yet, or null. It counts; the wording of the conditions is for the committee pack's readers. */
export async function committeeConditionsRefusal(db: Db, tenantId: string, applicationId: string): Promise<string | null> {
  const { conditions } = await loadConditions(db, tenantId, applicationId)
  const open = conditions.filter((c) => c.cleared === null).length
  return open === 0 ? null : `The credit committee approved this on conditions, and ${open} of ${conditions.length} ${conditions.length === 1 ? "is" : "are"} not yet met. Each must be cleared before the agreement is signed or the loan is paid out.`
}

/** Whoever said a condition is met does not also pay the loan out (segregation of duties; the database repeats it). */
export async function clearedConditions(db: Db, tenantId: string, applicationId: string): Promise<string[]> {
  const { conditions } = await loadConditions(db, tenantId, applicationId)
  return conditions.flatMap((c) => (c.cleared ? [c.cleared.byId] : []))
}

/** Records one condition as met: by someone who did not make the application, or stand in an account relation to who did, with what shows it. Audited. */
export async function clearCondition(input: {
  tenantId: string; actor: { id: string; email: string; role: UserRole; totpVerified?: boolean }; applicationId: string; index: number; note: string
}): Promise<ConditionState[]> {
  const { tenantId, actor, applicationId, index } = input
  const note = input.note.trim()
  if (note.length < 5 || note.length > 500) throw new ConditionError("INVALID", 422, "Say what shows the condition is met, in 5 to 500 characters.")
  if (actor.totpVerified !== true && (await isStaffTotpRequired(tenantId))) {
    throw new ConditionError("TOTP_REQUIRED", 403, "Sign in with two-factor authentication to clear a condition.")
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const { caseId, conditions } = await loadConditions(tx, tenantId, applicationId)
      const target = conditions.find((c) => c.index === index)
      if (!caseId || !target) throw new ConditionError("NO_CONDITION", 404, "This application has no such condition.")
      if (target.cleared) throw new ConditionError("ALREADY_CLEARED", 409, "This condition is already cleared.")
      const application = await tx.loanApplication.findFirst({ where: { id: applicationId, tenantId }, select: { inputStaffIds: true } })
      if (application?.inputStaffIds.includes(actor.id)) throw new ConditionError("MAKER", 403, "You captured this application or changed its figures, so someone else must clear its conditions.")
      const controlled = await accountControlRefusal(tx, { tenantId, makerIds: application?.inputStaffIds ?? [], checkerId: actor.id })
      if (controlled) throw new ConditionError("ACCOUNT_CONTROLLED", 403, controlled)
      await tx.approvalConditionClearance.create({ data: { tenantId, caseId, applicationId, conditionIndex: index, condition: target.text, note, clearedById: actor.id } })
      await logAuditStrict({
        tenantId, userId: actor.id, userEmail: actor.email, action: AuditAction.COMMITTEE_CONDITION_CLEARED, entity: "LoanApplication", entityId: applicationId,
        newValue: { caseId, conditionIndex: index, condition: target.text, note },
      }, tx)
      return (await loadConditions(tx, tenantId, applicationId)).conditions
    })
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new ConditionError("ALREADY_CLEARED", 409, "This condition is already cleared.")
    if (isCheckViolation(error)) throw new ConditionError("NO_CONDITION", 409, "This condition cannot be cleared on the application as it stands.")
    throw error
  }
}
