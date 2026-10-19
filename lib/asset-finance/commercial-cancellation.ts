import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { syncLoanCharges } from "@/lib/loan/charges-sync"
import { cancellationEvidenceWhere } from "./borrower-document-scope"
import { dbDate, isoOfDbDate } from "./dates"
import type { RecoveryActor } from "./recovery-create"
import { RecoveryRefusal, refusable } from "./recovery-result"

export interface CommercialCancellationInput { cancelledOn: string; evidenceDocumentId: string; basis: string; cancellationConfirmed: true }
export function parseCommercialCancellation(body: unknown): CommercialCancellationInput | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Provide the actual cancellation date and its evidence"
  const b = body as Record<string, unknown>
  if (typeof b.cancelledOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.cancelledOn) || !Number.isFinite(Date.parse(b.cancelledOn)) || new Date(b.cancelledOn).toISOString().slice(0, 10) !== b.cancelledOn) return "Provide a valid cancellation date"
  if (typeof b.evidenceDocumentId !== "string" || !b.evidenceDocumentId.trim()) return "Choose the cancellation evidence document"
  if (typeof b.basis !== "string" || b.basis.trim().length < 10 || b.basis.trim().length > 2000) return "Explain the cancellation evidence in 10–2000 characters"
  if (b.cancellationConfirmed !== true) return "Confirm that the evidence records actual cancellation, not merely possession or voluntary return"
  return { cancelledOn: b.cancelledOn, evidenceDocumentId: b.evidenceDocumentId.trim(), basis: b.basis.trim(), cancellationConfirmed: true }
}

/** Record an evidenced actual event; the date is never inferred from a sale or recovery. */
export async function recordCommercialCancellation(actor: RecoveryActor, loanId: string, input: CommercialCancellationInput) {
  return refusable(() => prisma.$transaction(async (tx) => {
    await lockLoanForUpdate(tx, loanId)
    const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId: actor.tenantId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } }, assetFinanceDeal: { select: { id: true } }, commercialCancellationEvent: true } })
    if (!loan) return { kind: "not_found" as const }
    if (loan.ncaRegime !== "NON_NCA" || loan.contractType !== "INSTALMENT_SALE") throw new RecoveryRefusal("Cancellation recording applies to a NON_NCA instalment sale")
    if (loan.repaymentSchedule.length === 0) throw new RecoveryRefusal("The booked repayment schedule is required before cancellation can be recorded")
    if (loan.commercialCancellationEvent) throw new RecoveryRefusal("The evidenced cancellation date is already recorded and permanent")
    if (!["ACTIVE", "DEFAULTED", "PENDING_WRITE_OFF"].includes(loan.status)) throw new RecoveryRefusal("Record cancellation on an open commercial agreement")
    if (input.cancelledOn < sastCalendarDate(loan.startDate) || input.cancelledOn > sastCalendarDate(new Date())) throw new RecoveryRefusal("The actual cancellation date must be between contract start and today")
    // Keep the same agreement → evidence lock order as the database guard.
    // Validate after a pending evidence edit has committed, never from its old image.
    await tx.$queryRaw`SELECT "id" FROM "EntityDocument" WHERE "id" = ${input.evidenceDocumentId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`
    const evidence = await tx.entityDocument.findFirst({ where: { id: input.evidenceDocumentId, ...cancellationEvidenceWhere(actor.tenantId, loan) } })
    if (!evidence) throw new RecoveryRefusal("Choose live staff-uploaded legal evidence belonging to this borrower and agreement")
    const cancellation = await tx.commercialCancellation.create({ data: { tenantId: actor.tenantId, loanId, cancelledOn: dbDate(input.cancelledOn), evidenceDocumentId: evidence.id,
      basis: input.basis, cancellationConfirmed: true, recordedById: actor.userId } })
    await tx.loan.update({ where: { id: loanId, tenantId: actor.tenantId }, data: { commercialCancelledAt: new Date(`${input.cancelledOn}T00:00:00+02:00`) } })
    await syncLoanCharges(tx, { tenantId: actor.tenantId, loanId }, new Date(), { source: "evidenced_commercial_cancellation", userId: actor.userId, userEmail: actor.userEmail })
    await logAuditStrict({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined,
      action: AuditAction.ASSET_COMMERCIAL_CANCELLATION_RECORDED, entity: "CommercialCancellation", entityId: cancellation.id,
      newValue: { loanId, cancelledOn: isoOfDbDate(cancellation.cancelledOn), evidenceDocumentId: evidence.id, evidenceSha256: evidence.contentSha256, basis: input.basis,
        originalTotalInterest: loan.contractualTotalInterest ?? loan.totalInterest, originalTotalRepayable: loan.contractualTotalRepayable ?? loan.totalRepayable,
        originalRows: loan.repaymentSchedule.map((row) => ({ id: row.id, dueDate: row.dueDate.toISOString(), principalDue: row.principalDue,
          interestDue: row.commonLawContractualInterestDue ?? row.interestDue, feesDue: row.feesDue, totalDue: row.totalDue - row.interestDue + (row.commonLawContractualInterestDue ?? row.interestDue) })) } }, tx)
    return { kind: "done" as const, id: cancellation.id, loanId, cancelledOn: input.cancelledOn }
  }, { timeout: 30000 }))
}
