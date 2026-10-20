import { NextRequest, NextResponse } from "next/server"
import { dealerNotFound, withDealer } from "@/lib/dealer/guards"
import { refusalResponse } from "@/lib/dealer/http"
import { parseEntityDocumentForm } from "@/lib/asset-finance/entity-document-io"
import { DEALER_UPLOAD_DOC_TYPES, listDealerDocuments, uploadDealerDocument } from "@/lib/dealer/documents"

type Params = { params: Promise<{ id: string }> }

/** The documents this dealer's users uploaded on its own deal. */
export async function GET(req: NextRequest, { params }: Params) {
  return withDealer(req, {}, async (actor) => {
    const { id } = await params
    const documents = await listDealerDocuments(actor, id)
    if (!documents) return dealerNotFound()
    return NextResponse.json(documents.map((d) => ({
      id: d.id, docType: d.docType, fileName: d.fileName, mimeType: d.mimeType, fileSize: d.fileSize, uploadedAt: d.createdAt.toISOString(),
    })))
  })
}

/**
 * Upload a document on the dealer's own deal (multipart: file, docType). With
 * `?requestId=` the upload answers that document request of the deal, of the
 * same type, once. Audited ENTITY_DOCUMENT_UPLOADED (and
 * DEALER_DOCUMENT_REQUEST_FULFILLED) with the dealer actor.
 */
export async function POST(req: NextRequest, { params }: Params) {
  return withDealer(req, {}, async (actor) => {
    const { id } = await params
    const requestId = req.nextUrl.searchParams.get("requestId")
    const parsed = await parseEntityDocumentForm(req, DEALER_UPLOAD_DOC_TYPES, { allowDeal: false })
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const result = await uploadDealerDocument(actor, id, parsed.upload, requestId && requestId.trim() !== "" ? requestId.trim() : null)
    if (result.kind === "refused") return refusalResponse(result)
    const d = result.document
    return NextResponse.json({ id: d.id, docType: d.docType, fileName: d.fileName, uploadedAt: d.createdAt }, { status: 201 })
  })
}
