import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { getPortalClient, withPortalEntity } from "@/lib/asset-finance/portal-route"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"

type Params = { params: Promise<{ id: string; documentId: string }> }

/**
 * The document's bytes (`?download=1` as an attachment) for a client with
 * authority over its entity. Writes a DocumentAccessLog row; a refusal is
 * audited, so probing for other entities' documents leaves a trace.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id, documentId } = await params
  const outcome = await withPortalEntity(req, id, async ({ tenantId, client }) => {
    const doc = await prisma.entityDocument.findFirst({
      where: { id: documentId, entityId: id, tenantId, deletedAt: null },
      select: { id: true, fileName: true, mimeType: true, storagePath: true, contentSha256: true },
    })
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return serveEntityDocument(req, doc, { type: "client", id: client.clientId })
  })

  if (outcome.status === 403 || outcome.status === 404) {
    const client = await getPortalClient()
    await auditRefusal({
      action: AuditAction.DOCUMENT_ACCESS_REFUSED,
      entity: "EntityDocument",
      entityId: documentId,
      tenantId: client?.tenantId,
      userEmail: client?.email,
      reason: outcome.status === 403 ? "tenant_scope_refused" : "not_authorised_for_entity_or_not_found",
      status: outcome.status,
      detail: { accessorType: "client", accessorId: client?.clientId ?? null, businessEntityId: id },
    })
  }
  return outcome
}
