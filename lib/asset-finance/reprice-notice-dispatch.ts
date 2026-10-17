/** Dispatch committed rate-change outbox rows through the existing pipeline.
 * Email only: SMS is off and WhatsApp requires an approved provider template.
 * A provider-accepted Message completes the notice; simulation, consent blocks,
 * missing contacts, pending sends and ambiguous outcomes remain staff-visible.
 */
import { Prisma, type AssetFinanceRateNotice } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lookupContactByChannelValue, normaliseEmail } from "@/lib/contact/identity"
import { SendBlockedError, sendMessage } from "@/lib/messaging/send"
import { reconciliationMessageFromError } from "@/lib/messaging/dispatch-control"
import { escapeHtml } from "@/lib/utils"
import { rateTaxDocuments, rateTaxDocumentText } from "./rate-tax-documents"
import { isoOfDbDate } from "./dates"

export type RateNoticeDb = Pick<typeof prisma, "assetFinanceRateNotice" | "client" | "messageTemplate" | "auditLog" | "$transaction" | "contact" | "contactIdentity" | "loan">
type Recipient = { id: string; firstName: string; lastName: string; email: string }
type Outcome = { clientId: string; channel: "EMAIL"; status: string; messageId?: string; reason?: string }
const ACCEPTED = new Set(["SENT", "DELIVERED", "READ"])

export function rateNoticeVars(notice: AssetFinanceRateNotice, recipient: Recipient, statutory = false): Record<string, string> {
  const percent = new Prisma.Decimal(notice.resultingRate.toString()).mul(100)
  const rate = percent.toFixed(Math.max(2, percent.decimalPlaces()))
  const lines = [
    `Dear ${recipient.firstName} ${recipient.lastName},`,
    `The annual contract rate on account ${notice.loanReference} changes to ${rate}% from ${isoOfDbDate(notice.effectiveDate)}.`,
    notice.correctionPendingManual ? notice.newInstalmentCents === 0 && notice.oldInstalmentCents > 0 ? "The revised rate pays off your account. No further scheduled payments are due. Your cash payments are preserved in total; excess cash is held separately pending refund execution." : "The recorded scheduled payments are unchanged. Any separate balance correction is set out below." : `From the payment due ${isoOfDbDate(notice.firstChangedPaymentDate)}, the instalment or rental changes from R${(notice.oldInstalmentCents / 100).toFixed(2)} to R${(notice.newInstalmentCents / 100).toFixed(2)}.`,
    ...(notice.historicalBalanceAdjustmentCents ? [`Prior-period balance correction: ${notice.historicalBalanceAdjustmentCents < 0 ? "credit" : "debit"} R${(Math.abs(notice.historicalBalanceAdjustmentCents) / 100).toFixed(2)}. Your recorded cash payments are preserved in total; ${notice.correctionPendingManual ? "this separate correction is pending manual execution. Any credit is recorded separately for reconciliation; no refund or debit has been executed" : "this correction is included in the recalculated balance"}.`] : []),
    ...(statutory ? [`The total interest payable under the agreement is R${(notice.totalInterestCents / 100).toFixed(2)}; interest payable in the first changed monthly scheduled period is R${(notice.monthlyInterestCents / 100).toFixed(2)}, assuming the reference rate does not change again and payments are made as scheduled.`] : []),
    "This is the scheduled payment including fees, maintenance charges and VAT, where applicable. Please refer to the updated schedule for any irregular payments or final balloon amount.",
    ...(notice.taxAdjustmentPending ? ["The portion relating to an unmade rental supply is awaiting its actual supply and original invoice. Its gross amount uses provisional booked VAT. No VAT adjustment document has been issued for that portion; the actual supply-date VAT and its written document will follow."] : []),
    ...rateTaxDocuments(notice.taxDocuments).map(rateTaxDocumentText),
    "Please contact your lender if you need an updated schedule or have a question about this change.",
  ]
  return { subject: `Rate and payment change: ${notice.loanReference}`, text: lines.join("\n\n"), html: lines.map((x) => `<p>${escapeHtml(x)}</p>`).join("") }
}

export async function dispatchRepriceNotices(db: RateNoticeDb, tenantId: string, send: typeof sendMessage = sendMessage): Promise<{ completed: number; pending: number }> {
  const result = { completed: 0, pending: 0 }
  const notices = await db.assetFinanceRateNotice.findMany({
    where: { tenantId, completedAt: null }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })
  for (const notice of notices) {
    const loan = await db.loan.findFirst({ where: { id: notice.loanId, tenantId }, select: { entityId: true, clientId: true, ncaRegime: true } })
    const statutory = loan?.ncaRegime === "NCA"
    const template = await db.messageTemplate.findFirst({ where: {
      tenantId, key: statutory ? "asset_finance_rate_notice_nca_email" : "asset_finance_rate_notice_email", channel: "EMAIL", active: true,
    } })
    const recipients = await db.client.findMany({
      where: { tenantId, id: { in: notice.recipientClientIds }, deceasedAt: null,
        ...(loan?.entityId ? { entityRelationships: { some: { tenantId, entityId: loan.entityId, active: true, role: { in: ["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"] } } } } : { id: { in: notice.recipientClientIds.filter((id) => id === loan?.clientId) } }),
      },
      select: { id: true, firstName: true, lastName: true, email: true },
    })
    const outcomes: Outcome[] = []
    for (const recipient of recipients) {
      const leg = { clientId: recipient.id, channel: "EMAIL" as const }
      if (!template || template.statutoryOverride !== statutory) {
        outcomes.push({ ...leg, status: "BLOCKED", reason: "Active rate-notice email template is missing or its statutory policy is misconfigured" })
        continue
      }
      const email = normaliseEmail(recipient.email)
      const contact = email ? await lookupContactByChannelValue(db, { tenantId, channel: "EMAIL", value: email }) : null
      if (!contact) { outcomes.push({ ...leg, status: "BLOCKED", reason: "No deliverable email Contact on file" }); continue }
      try {
        const message = await send({
          contactId: contact.id, channel: "EMAIL", template, toValue: email,
          toName: `${recipient.firstName} ${recipient.lastName}`, vars: rateNoticeVars(notice, recipient, statutory),
          loanId: notice.loanId, category: "asset_finance_rate_notice",
          idempotencyKey: `rate-notice:${notice.contractRateId}:${recipient.id}:EMAIL${notice.taxAdjustmentRevision ? `:tax:${notice.taxAdjustmentRevision}` : ""}`,
        })
        outcomes.push({ ...leg, status: message.status, messageId: message.id })
      } catch (error) {
        const uncertain = reconciliationMessageFromError(error)
        outcomes.push(uncertain
          ? { ...leg, status: "RECONCILIATION", messageId: uncertain.id, reason: "Provider outcome requires reconciliation; replay blocked" }
          : error instanceof SendBlockedError
            ? { ...leg, status: "BLOCKED", reason: error.reason }
            : { ...leg, status: "FAILED", reason: error instanceof Error ? error.name : "Unknown error" })
      }
    }
    for (const missing of notice.recipientClientIds.filter((id) => !recipients.some((r) => r.id === id))) {
      outcomes.push({ clientId: missing, channel: "EMAIL", status: "BLOCKED", reason: "Recipient unavailable or deceased" })
    }
    const completed = outcomes.length > 0 && outcomes.every((outcome) => ACCEPTED.has(outcome.status))
    const persisted = await db.$transaction(async (tx) => {
      const written = await tx.assetFinanceRateNotice.updateMany({ where: { id: notice.id, tenantId, taxAdjustmentRevision: notice.taxAdjustmentRevision, completedAt: null }, data: { completedAt: completed ? new Date() : null, lastOutcomes: outcomes } })
      if (written.count !== 1) return false
      await logAuditStrict({
        tenantId, userEmail: "system@asset-finance-reprice", action: AuditAction.ASSET_FINANCE_RATE_NOTICE_DISPATCH,
        entity: "AssetFinanceRateNotice", entityId: notice.id, newValue: { completed, outcomes },
      }, tx)
      return true
    })
    result[completed && persisted ? "completed" : "pending"]++
  }
  return result
}
