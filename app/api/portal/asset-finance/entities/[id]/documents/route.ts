import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit } from "@/lib/rate-limit"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { PORTAL_UPLOAD_DOC_TYPES } from "@/lib/asset-finance/entity-documents"
import { EntityDocumentCapError, parseEntityDocumentForm, storeEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { loadPortalEntityDocuments } from "@/lib/asset-finance/portal-access"
import { PORTAL_ENTITY_DOCUMENT_CAP, PORTAL_ENTITY_UPLOAD_RATE_LIMIT } from "@/lib/asset-finance/portal-rate-limits"

type Params = { params: Promise<{ id: string }> }

/** The entity's live documents this client may see (metadata only; another surety's signed suretyship is withheld). */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withPortalEntity(req, id, async ({ tenantId, client }) =>
    NextResponse.json(await loadPortalEntityDocuments(tenantId, id, client.clientId)),
  )
}

/**
 * Upload an onboarding document for the entity (multipart: file, docType).
 * 429 past PORTAL_ENTITY_UPLOAD_RATE_LIMIT per client; 409 once the entity
 * holds PORTAL_ENTITY_DOCUMENT_CAP live documents.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withPortalEntity(req, id, async ({ tenantId, client }) => {
    const gate = await checkRateLimit(`portal:af-upload:${tenantId}:${client.clientId}`, PORTAL_ENTITY_UPLOAD_RATE_LIMIT)
    if (!gate.allowed) {
      return NextResponse.json(
        { error: "Too many uploads. Please wait a few minutes and try again." },
        { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
      )
    }
    const parsed = await parseEntityDocumentForm(req, PORTAL_UPLOAD_DOC_TYPES, { allowDeal: false })
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    try {
      const document = await storeEntityDocument({
        tenantId,
        entityId: id,
        upload: parsed.upload,
        uploader: { type: "client", id: client.clientId, email: client.email ?? undefined },
        liveDocumentCap: PORTAL_ENTITY_DOCUMENT_CAP,
      })
      return NextResponse.json(document, { status: 201 })
    } catch (error) {
      if (error instanceof EntityDocumentCapError) return NextResponse.json({ error: error.message }, { status: 409 })
      throw error
    }
  })
}
