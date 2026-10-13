/**
 * The new-instalment notice after a repricing (goal 4.4).
 *
 * // PARTIAL: nothing is sent to the borrower and nothing is queued for them.
 * The messaging pipeline has no deferred outbox: sendMessage() and
 * triggerNotification() dispatch at once, from a closed list of events whose
 * borrower copy is customer-facing and needs sign-off before it exists. So
 * inside the repricing transaction this only (1) resolves who must receive
 * the notice and (2) puts a bell item in front of the tenant's loan admins and
 * managers, so a person sends it. The recipient ids go into the repricing
 * audit row.
 *
 * Recipients: the borrowing entity's ACTIVE relationships in a role that acts
 * for it (DIRECTOR, TRUSTEE, AUTHORISED_SIGNATORY), as Client ids, once each.
 * A SURETY, MEMBER or BENEFICIAL_OWNER alone is not a recipient.
 */
import type { EntityRole } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import type { NotificationType } from "@/lib/notifications/bell"

export type NoticeDb = Pick<typeof prisma, "entityRelationship" | "user" | "notification">

export const NOTICE_ROLES: readonly EntityRole[] = ["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"]
// The roles the bureau job alerts too (lib/bureau-submission/generate.ts).
const ALERTED_STAFF_ROLES = ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"] as const

export interface RepriceNotice {
  tenantId: string
  loanId: string
  loanReference: string
  entityId: string | null
  effectiveDate: string
  oldInstalmentCents: number
  newInstalmentCents: number
}

const rand = (cents: number): string => `R${(cents / 100).toFixed(2)}`

export interface LoanAdminAlert {
  type: NotificationType
  title: string
  body: string
  entityType: string
  entityId: string
}

/** A bell item for each of the tenant's active loan admins and managers. */
export async function alertLoanAdmins(db: Pick<NoticeDb, "user" | "notification">, tenantId: string, alert: LoanAdminAlert): Promise<number> {
  const staff = await db.user.findMany({
    where: { tenantId, active: true, role: { in: [...ALERTED_STAFF_ROLES] } },
    select: { id: true },
  })
  await db.notification.createMany({ data: staff.map((user) => ({ tenantId, userId: user.id, ...alert })) })
  return staff.length
}

/** Resolves the recipients and raises the staff bell items; returns the recipient Client ids. */
export async function queueRepriceNotice(db: NoticeDb, notice: RepriceNotice): Promise<string[]> {
  const relationships = notice.entityId === null ? [] : await db.entityRelationship.findMany({
    where: { tenantId: notice.tenantId, entityId: notice.entityId, active: true, role: { in: [...NOTICE_ROLES] } },
    select: { clientId: true },
    orderBy: { clientId: "asc" },
  })
  const recipientClientIds = [...new Set(relationships.map((r) => r.clientId))]

  const recipients = recipientClientIds.length === 0
    ? "The borrower has no active director, trustee or authorised signatory to send it to."
    : `Send it to the borrower's ${recipientClientIds.length} director(s), trustee(s) or authorised signatory(ies).`
  await alertLoanAdmins(db, notice.tenantId, {
    type: "LOAN_REPRICED",
    title: `Loan ${notice.loanReference} repriced: new instalment notice to send`,
    body: `From ${notice.effectiveDate} the base instalment moves from ${rand(notice.oldInstalmentCents)} to ${rand(notice.newInstalmentCents)}. No notice has been sent. ${recipients}`,
    entityType: "Loan",
    entityId: notice.loanId,
  })
  return recipientClientIds
}
