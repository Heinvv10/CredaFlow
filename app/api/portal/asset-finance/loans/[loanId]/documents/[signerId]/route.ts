import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { withPortalLoanDocument, portalLoanNotFound } from "@/lib/asset-finance/portal-loan-route"
import { portalVisibleSignerWhere } from "@/lib/asset-finance/portal-contract"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { dealDocumentFileName } from "@/lib/asset-finance/documents/render"

type Params = { params: Promise<{ loanId: string; signerId: string }> }

/**
 * A rendered deal document of this contract (`?download=1` as an attachment):
 * the agreement or resolution, or the client's OWN suretyship
 * (portalVisibleSignerWhere). Logged in DocumentAccessLog against the signer
 * row's id, like the signer's own document route.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { loanId, signerId } = await params
  return withPortalLoanDocument(req, loanId, { entity: "DealSigner", entityId: signerId }, async ({ tenantId, client }) => {
    const signer = await prisma.dealSigner.findFirst({
      where: { id: signerId, tenantId, deal: { loanId }, ...portalVisibleSignerWhere(client.clientId) },
      select: {
        id: true, document: true, documentSha256: true, documentStoragePath: true,
        client: { select: { firstName: true, lastName: true } },
        deal: { select: { application: { select: { reference: true } } } },
      },
    })
    if (!signer?.documentSha256 || !signer.documentStoragePath) return portalLoanNotFound()
    return serveEntityDocument(req, {
      id: signer.id,
      fileName: dealDocumentFileName(signer.deal.application.reference, signer.document, `${signer.client.firstName} ${signer.client.lastName}`),
      mimeType: "application/pdf",
      storagePath: signer.documentStoragePath,
      contentSha256: signer.documentSha256,
    }, { type: "client", id: client.clientId })
  })
}
