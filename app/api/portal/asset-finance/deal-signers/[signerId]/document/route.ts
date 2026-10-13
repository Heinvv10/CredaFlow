import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { dealDocumentFileName } from "@/lib/asset-finance/documents/render"
import { portalSignerAuthorityWhere } from "@/lib/asset-finance/portal-access"

/**
 * A portal client's OWN deal document to read before signing
 * (`?download=1` as an attachment). Keyed by the signer row AND the session
 * client: no entity access is granted, so a surety reads their suretyship
 * and nothing else; anyone else's row is 404. So is the client's own row once
 * they no longer hold the relationship that authorises it
 * (portalSignerAuthorityWhere). Logged in DocumentAccessLog against the
 * signer row's id.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ signerId: string }> }) {
  const { signerId } = await params
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    const signer = await prisma.dealSigner.findFirst({
      where: {
        id: signerId, tenantId, clientId: client.clientId, deal: { status: { in: ["APPROVED", "CONTRACTED", "BOOKED"] } },
        AND: [portalSignerAuthorityWhere(tenantId, client.clientId)],
      },
      select: {
        id: true, document: true, documentSha256: true, documentStoragePath: true,
        client: { select: { firstName: true, lastName: true } },
        deal: { select: { application: { select: { reference: true } } } },
      },
    })
    if (!signer?.documentSha256 || !signer.documentStoragePath) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return serveEntityDocument(req, {
      id: signer.id,
      fileName: dealDocumentFileName(signer.deal.application.reference, signer.document, `${signer.client.firstName} ${signer.client.lastName}`),
      mimeType: "application/pdf",
      storagePath: signer.documentStoragePath,
      contentSha256: signer.documentSha256,
    }, { type: "client", id: client.clientId })
  })
}
