import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { logDocumentAccess } from "@/lib/document-auth"
import { renderEntityStatementPdf } from "@/lib/asset-finance/documents/statement-pdf"
import { withPortalLoanDocument, portalLoanNotFound } from "@/lib/asset-finance/portal-loan-route"

type Params = { params: Promise<{ loanId: string }> }

/**
 * The contract's statement as a PDF (`?download=1` as an attachment) for a
 * client with authority over the loan's entity. The read is logged in
 * DocumentAccessLog against the loan before rendering, as the staff
 * statement route does.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return withPortalLoanDocument(req, loanId, { entity: "Loan", entityId: loanId }, async ({ tenantId, client }) => {
    const isDownload = new URL(req.url).searchParams.get("download") === "1"
    await logDocumentAccess(prisma, {
      documentId: loanId, accessorType: "client", accessorId: client.clientId, action: isDownload ? "download" : "view", req,
    })
    const result = await renderEntityStatementPdf(tenantId, loanId)
    if (result.kind === "not_found") return portalLoanNotFound()
    if (result.kind === "refused") return result.response
    return new NextResponse(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${isDownload ? "attachment" : "inline"}; filename="${result.filename}"`,
        "Content-Length": String(result.bytes.length),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  })
}
