import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withPortalLeaseDocument } from "@/lib/asset-finance/lease-portal-route"
import { isLeaseDocumentKind, leaseDocumentTarget, serveLeaseDocument } from "@/lib/asset-finance/documents/lease/lease-docs-serve"

type Params = { params: Promise<{ loanId: string; kind: string }> }

/**
 * A lease's servicing document as a PDF (`expiry-notice`, `termination-quote`
 * with `?quoteId=`, `inspection-report`; `?download=1` as an attachment), for
 * the lessee or a client with authority over the lessee entity
 * (lib/asset-finance/lease-portal-route.ts). A 403 or 404 is audited as
 * DOCUMENT_ACCESS_REFUSED; the read is logged in DocumentAccessLog before rendering.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { loanId, kind } = await params
  return withPortalLeaseDocument(req, loanId, leaseDocumentTarget(loanId), async ({ tenantId, client }) => {
    if (!isLeaseDocumentKind(kind)) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return serveLeaseDocument(prisma, req, { tenantId, loanId, kind }, { type: "client", id: client.clientId })
  })
}
