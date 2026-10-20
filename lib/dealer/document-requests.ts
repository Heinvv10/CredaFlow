/**
 * Staff asking the dealer for a document on a dealer deal. The note is shown
 * to the dealer, so it never carries a credit reason (the staff UI says so).
 * The dealer answers by uploading with the request's id
 * (lib/dealer/documents.ts), which fulfils it once (guardDealerDocumentRequest).
 */
import type { EntityDocumentType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { StaffActor } from "./actor"
import { DEALER_UPLOAD_DOC_TYPES } from "./documents"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

/** manage_asset_finance, checked by the route. */
export async function requestDealerDocument(
  staff: StaffActor,
  dealId: string,
  input: { docType: unknown; note: unknown },
): Promise<{ kind: "requested"; requestId: string } | DealerRefusal> {
  if (!(DEALER_UPLOAD_DOC_TYPES as readonly unknown[]).includes(input.docType)) {
    return dealerRefused(400, `docType must be one of ${DEALER_UPLOAD_DOC_TYPES.join(", ")}`)
  }
  const note = typeof input.note === "string" ? input.note.trim() : ""
  if (note.length < 1 || note.length > 500) return dealerRefused(400, "A note of 1-500 characters is required")
  const docType = input.docType as EntityDocumentType
  return prisma.$transaction(async (tx) => {
    const deal = await tx.assetFinanceDeal.findFirst({ where: { id: dealId, tenantId: staff.tenantId }, select: { id: true, dealerId: true } })
    if (!deal) return dealerMiss("Deal")
    if (!deal.dealerId) return dealerRefused(409, "Only a dealer deal takes document requests")
    const row = await tx.dealerDocumentRequest.create({
      data: { tenantId: staff.tenantId, dealId: deal.id, docType, note, requestedById: staff.userId },
      select: { id: true },
    })
    await logAuditStrict({
      tenantId: staff.tenantId, userId: staff.userId, userEmail: staff.userEmail,
      action: AuditAction.DEALER_DOCUMENT_REQUESTED, entity: "DealerDocumentRequest", entityId: row.id,
      newValue: { dealId: deal.id, dealerId: deal.dealerId, docType, note },
    }, tx)
    return { kind: "requested" as const, requestId: row.id }
  })
}
