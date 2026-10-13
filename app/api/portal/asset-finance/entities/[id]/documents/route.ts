import { NextRequest, NextResponse } from "next/server"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { PORTAL_UPLOAD_DOC_TYPES } from "@/lib/asset-finance/entity-documents"
import { parseEntityDocumentForm, storeEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { loadPortalEntityDocuments } from "@/lib/asset-finance/portal-access"

type Params = { params: Promise<{ id: string }> }

/** The entity's live documents this client may see (metadata only; another surety's signed suretyship is withheld). */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withPortalEntity(req, id, async ({ tenantId, client }) =>
    NextResponse.json(await loadPortalEntityDocuments(tenantId, id, client.clientId)),
  )
}

/** Upload an onboarding document for the entity (multipart: file, docType). */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = await params
  return withPortalEntity(req, id, async ({ tenantId, client }) => {
    const parsed = await parseEntityDocumentForm(req, PORTAL_UPLOAD_DOC_TYPES, { allowDeal: false })
    if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const document = await storeEntityDocument({
      tenantId,
      entityId: id,
      upload: parsed.upload,
      uploader: { type: "client", id: client.clientId, email: client.email ?? undefined },
    })
    return NextResponse.json(document, { status: 201 })
  })
}
