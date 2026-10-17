/**
 * The new-instalment notice after a repricing (goal 4.4).
 *
 * The written notice is queued atomically with the repricing. A worker sends
 * it after commit through the outbound pipeline; failed and blocked outcomes
 * remain visible to staff and pending for reconciliation.
 *
 * Recipients: the entity's servicing contacts (./entity-contacts.ts
 * entityContactRecipients): ACTIVE directors, trustees and authorised
 * signatories with no recorded death, as Client ids, once each. A SURETY,
 * MEMBER or BENEFICIAL_OWNER alone is not a recipient.
 */
import type { prisma } from "@/lib/prisma"
import type { RateTaxDocument } from "./rate-tax-documents"
import type { NotificationType } from "@/lib/notifications/bell"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { dbDate } from "./dates"
import { entityContactRecipients } from "./entity-contacts"

export type NoticeDb = Pick<
  typeof prisma,
  "entityRelationship" | "user" | "notification" | "loan" | "client" | "assetFinanceRateNotice"
>
// The roles the bureau job alerts too (lib/bureau-submission/generate.ts).
const ALERTED_STAFF_ROLES = ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"] as const

export interface RepriceNotice {
  tenantId: string
  loanId: string
  loanReference: string
  entityId: string | null
  contractRateId: string
  resultingRate: string
  effectiveDate: string
  firstChangedPaymentDate: string
  taxAdjustmentPending?: boolean
  taxDocuments?: RateTaxDocument[]
  correctionPendingManual?: boolean
  historicalBalanceAdjustmentCents?: number
  totalInterestCents: number
  monthlyInterestCents: number
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
export async function alertLoanAdmins(
  db: Pick<NoticeDb, "user" | "notification">,
  tenantId: string,
  alert: LoanAdminAlert
): Promise<number> {
  const staff = await db.user.findMany({
    where: { tenantId, active: true, role: { in: [...ALERTED_STAFF_ROLES] } },
    select: { id: true },
  })
  await db.notification.createMany({ data: staff.map((user) => ({ tenantId, userId: user.id, ...alert })) })
  return staff.length
}

/** Resolves the recipients and raises the staff bell items; returns the recipient Client ids. */
export async function queueRepriceNotice(db: NoticeDb, notice: RepriceNotice): Promise<string[]> {
  const borrower = await db.loan.findFirst({
    where: { id: notice.loanId, tenantId: notice.tenantId },
    select: { clientId: true, ncaRegime: true },
  })
  const contacts = notice.entityId === null ? [] : await entityContactRecipients(db, notice.tenantId, notice.entityId)
  const recipientClientIds =
    notice.entityId === null && borrower?.clientId ? [borrower.clientId] : contacts.map((c) => c.clientId)
  await db.assetFinanceRateNotice.create({
    data: {
      tenantId: notice.tenantId,
      loanId: notice.loanId,
      contractRateId: notice.contractRateId,
      loanReference: notice.loanReference,
      resultingRate: notice.resultingRate,
      statutoryDueOn:
        borrower?.ncaRegime === "NCA" ? dbDate(addSouthAfricanBusinessDays(notice.effectiveDate, 30)) : null,
      effectiveDate: dbDate(notice.effectiveDate),
      firstChangedPaymentDate: dbDate(notice.firstChangedPaymentDate),
      oldInstalmentCents: notice.oldInstalmentCents,
      newInstalmentCents: notice.newInstalmentCents,
      historicalBalanceAdjustmentCents: notice.historicalBalanceAdjustmentCents ?? 0,
      correctionPendingManual: notice.correctionPendingManual ?? false,
      taxAdjustmentPending: notice.taxAdjustmentPending ?? false,
      ...(notice.taxDocuments
        ? { taxDocuments: notice.taxDocuments as unknown as import("@prisma/client").Prisma.InputJsonValue }
        : {}),
      recipientClientIds,
      totalInterestCents: notice.totalInterestCents,
      monthlyInterestCents: notice.monthlyInterestCents,
    },
  })

  const recipients =
    recipientClientIds.length === 0
      ? "The borrower has no active director, trustee or authorised signatory to send it to."
      : notice.entityId === null
        ? "The written notice is addressed to the borrower."
        : `The notice is addressed to ${recipientClientIds.length} director(s), trustee(s) or authorised signatory(ies).`
  await alertLoanAdmins(db, notice.tenantId, {
    type: "LOAN_REPRICED",
    title: `Loan ${notice.loanReference} repriced: new instalment notice to send`,
    body: `The contract rate changes from ${notice.effectiveDate}. From the payment due ${notice.firstChangedPaymentDate}, the instalment or rental moves from ${rand(notice.oldInstalmentCents)} to ${rand(notice.newInstalmentCents)}. The written notice is queued for delivery; check its delivery outcome. ${recipients}`,
    entityType: "Loan",
    entityId: notice.loanId,
  })
  return recipientClientIds
}
