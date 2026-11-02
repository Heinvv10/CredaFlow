import { clearedConditions } from "@/lib/approval/conditions"
import type { prisma } from "@/lib/prisma"
import { accountControlRefusal } from "@/lib/security/account-control"
import { segregationOfDutiesMakers } from "@/lib/security/segregation-of-duties"

type Db = Pick<typeof prisma, "approvalStep" | "approvalCase" | "approvalConditionClearance">

/** The columns the people behind a payout are read from. */
export const PAYOUT_PEOPLE_COLUMNS = {
  inputStaffIds: true, approvedById: true, recklessLendingAssessedById: true, incomeVerifiedById: true, bureauOverrideById: true, approvedBy: { select: { isSystem: true } },
} as const

interface Application {
  inputStaffIds: readonly string[]
  approvedById: string | null
  recklessLendingAssessedById: string | null
  incomeVerifiedById: string | null
  bureauOverrideById: string | null
  approvedBy: { isSystem: boolean } | null
}

/**
 * Everyone behind a key-facts payout: who captured the application or changed its figures, attested to it, approved it at any level and
 * cleared its conditions. The payer, the payout's preconditions and whoever confirms the account all read this one list, on the transaction's
 * own connection where there is one.
 */
export async function payoutPeople(db: Db, tenantId: string, applicationId: string, application: Application): Promise<string[]> {
  const steps = await db.approvalStep.findMany({ where: { tenantId, applicationId }, select: { approverId: true } })
  const clearers = await clearedConditions(db, tenantId, applicationId)
  const { inputStaffIds, recklessLendingAssessedById, incomeVerifiedById, bureauOverrideById } = application
  const makers = segregationOfDutiesMakers("disburse", { ...application, inputStaffIds: [...inputStaffIds], approvedBySystem: application.approvedBy?.isSystem === true, approvalStepApproverIds: steps.map((s) => s.approverId) })
  const people = [...makers, ...inputStaffIds, recklessLendingAssessedById, incomeVerifiedById, bureauOverrideById, ...clearers]
  return [...new Set(people.flatMap((id) => (id ? [id] : [])))]
}

/** Why `confirmerId` cannot confirm this payout's account: one of the people behind it, or a second account of one. Asked when they confirm, and again at payout. */
export async function confirmerRefusal(db: Pick<typeof prisma, "auditLog">, tenantId: string, people: readonly string[], confirmerId: string): Promise<string | null> {
  if (people.includes(confirmerId)) return "The payout account is confirmed by someone who took no part in this application: not whoever captured, attested to or approved it, or cleared its conditions."
  return accountControlRefusal(db, { tenantId, makerIds: people, checkerId: confirmerId })
}
