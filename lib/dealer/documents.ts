/**
 * Documents a dealer uploads on its own deals, through the same store as the
 * staff deal evidence (storeDealEvidenceDocument: MIME allow-list, size cap,
 * magic bytes, content hash, audit). uploadedByType 'dealer' and uploadedById
 * the DealerUser. A dealer upload never satisfies a staff-evidence gate (the
 * database requires uploadedByType 'staff' there; spec deviation 10).
 *
 * A dealer reads only documents its own users uploaded on its own deals, and
 * every read writes a DocumentAccessLog row (accessorType 'dealer') before the
 * bytes are read (serveEntityDocument). An upload naming a document request
 * fulfils it in the same transaction.
 *
 * Free uploads end at the hand-over (dealerSubmittedAt): from then on the
 * dealer uploads only to answer an open document request, so nothing lands
 * on the lender's deal unasked.
 */
import type { AssetDealStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { serveEntityDocument, storeDealEvidenceDocument, type ParsedEntityUpload } from "@/lib/asset-finance/entity-document-io"
import type { EntityDocumentView } from "@/lib/asset-finance/entity-documents"
import { dealerAuditFields, type DealerActor } from "./actor"
import { dealerDealWhere } from "./deals"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export { DEALER_UPLOAD_DOC_TYPES } from "./doc-types"

/** A deal in these states takes no more dealer documents. */
const CLOSED: readonly AssetDealStatus[] = ["REFUSED_NCA", "DECLINED", "CANCELLED"]

const ANSWERED = "This request has already been answered"

/** Another upload fulfilled the request between the check and this upload's transaction. */
class RequestAnsweredConcurrently extends Error {}

/** The documents the dealer's own users uploaded on the deal (the deal is already the dealer's). */
export function dealerDocumentWhere(actor: Pick<DealerActor, "tenantId" | "dealerId">, dealId: string) {
  return {
    tenantId: actor.tenantId, dealId, uploadedByType: "dealer", deletedAt: null,
    deal: { dealerId: actor.dealerId },
  }
}

export async function uploadDealerDocument(
  actor: DealerActor,
  dealId: string,
  upload: ParsedEntityUpload,
  requestId: string | null = null,
): Promise<{ kind: "stored"; document: EntityDocumentView } | DealerRefusal> {
  const deal = await prisma.assetFinanceDeal.findFirst({
    where: dealerDealWhere(actor, dealId),
    select: { id: true, status: true, dealerSubmittedAt: true, entityId: true, clientId: true },
  })
  if (!deal) return dealerMiss("Deal")
  if (CLOSED.includes(deal.status)) return dealerRefused(409, "This deal is closed and takes no more documents")
  if (requestId === null && (deal.status !== "DRAFT" || deal.dealerSubmittedAt)) {
    return dealerRefused(409, "The deal is with the lender: upload only to answer one of its document requests")
  }
  if (requestId !== null) {
    const request = await prisma.dealerDocumentRequest.findFirst({
      where: { id: requestId, tenantId: actor.tenantId, dealId: deal.id },
      select: { docType: true, fulfilledAt: true },
    })
    if (!request) return dealerMiss("Document request")
    if (request.fulfilledAt) return dealerRefused(409, ANSWERED)
    if (request.docType !== upload.docType) return dealerRefused(422, `This request asks for ${request.docType}`)
  }
  const audit = dealerAuditFields(actor)
  try {
    const document = await storeDealEvidenceDocument({
      tenantId: actor.tenantId, dealId: deal.id, entityId: deal.entityId, clientId: deal.clientId,
      upload: { ...upload, dealId: deal.id },
      uploader: { type: "dealer", id: actor.dealerUserId, email: actor.email, dealerId: actor.dealerId },
      withinTransaction: requestId === null ? undefined : async (tx, stored) => {
        const fulfilled = await tx.dealerDocumentRequest.updateMany({
          where: { id: requestId, tenantId: actor.tenantId, dealId: deal.id, fulfilledAt: null },
          data: { fulfilledDocumentId: stored.id, fulfilledAt: new Date() },
        })
        if (fulfilled.count !== 1) throw new RequestAnsweredConcurrently()
        await logAuditStrict({
          tenantId: actor.tenantId, userId: audit.userId, userEmail: audit.userEmail,
          action: AuditAction.DEALER_DOCUMENT_REQUEST_FULFILLED, entity: "DealerDocumentRequest", entityId: requestId,
          newValue: { dealId: deal.id, documentId: stored.id, docType: upload.docType, actor: audit.actor },
        }, tx)
      },
    })
    return { kind: "stored", document }
  } catch (error) {
    if (error instanceof RequestAnsweredConcurrently) return dealerRefused(409, ANSWERED)
    throw error
  }
}

/** The dealer's own documents on its own deal, newest first; null when the deal is not the dealer's. */
export async function listDealerDocuments(actor: DealerActor, dealId: string) {
  const deal = await prisma.assetFinanceDeal.findFirst({ where: dealerDealWhere(actor, dealId), select: { id: true } })
  if (!deal) return null
  return prisma.entityDocument.findMany({
    where: dealerDocumentWhere(actor, deal.id),
    select: { id: true, docType: true, fileName: true, mimeType: true, fileSize: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  })
}

/** Serve one of the dealer's own documents, logging the access first; 404 for anything else. */
export async function serveDealerDocument(req: Request, actor: DealerActor, dealId: string, documentId: string): Promise<Response> {
  const doc = await prisma.entityDocument.findFirst({
    where: { id: documentId, ...dealerDocumentWhere(actor, dealId) },
    select: { id: true, fileName: true, mimeType: true, storagePath: true, contentSha256: true },
  })
  if (!doc) return Response.json({ error: "Document not found" }, { status: 404 })
  return serveEntityDocument(req, doc, { type: "dealer", id: actor.dealerUserId })
}
