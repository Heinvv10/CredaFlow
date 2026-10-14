import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withSigningStaff } from "@/lib/asset-finance/signing-route"
import { serveEntityDocument } from "@/lib/asset-finance/entity-document-io"
import { dealDocumentFileName } from "@/lib/asset-finance/documents/render"

/**
 * The prepared (unsigned) document a signer row binds, as stored at
 * preparation (any staff role; `?download=1` as an attachment). The read is
 * logged in DocumentAccessLog against the signer row's id, and the bytes must
 * still hash to the bound digest.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; signerId: string }> }) {
  const { id, signerId } = await params
  return withSigningStaff(req, { dealId: id, manage: false }, async ({ tenantId, user }) => {
    const signer = await prisma.dealSigner.findFirst({
      where: { id: signerId, dealId: id, tenantId },
      select: {
        id: true, document: true, documentSha256: true, documentStoragePath: true,
        client: { select: { firstName: true, lastName: true } },
        deal: { select: { application: { select: { reference: true } } } },
      },
    })
    if (!signer?.documentSha256 || !signer.documentStoragePath) return NextResponse.json({ error: "Document not found" }, { status: 404 })
    return serveEntityDocument(req, {
      id: signer.id,
      fileName: dealDocumentFileName(signer.deal.application.reference, signer.document, `${signer.client.firstName} ${signer.client.lastName}`),
      mimeType: "application/pdf",
      storagePath: signer.documentStoragePath,
      contentSha256: signer.documentSha256,
    }, { type: "staff", id: user.id })
  })
}
