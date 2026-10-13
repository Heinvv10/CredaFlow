import { NextRequest, NextResponse } from "next/server"
import { withPortalLoanDocument } from "@/lib/asset-finance/portal-loan-route"

type Params = { params: Promise<{ loanId: string }> }

/**
 * The contract's statement as a PDF for a client with authority over the
 * loan's entity. The authority gate (and the refusal audit) is live; the
 * entity statement renderer belongs to the servicing work and has not landed.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return withPortalLoanDocument(req, loanId, { entity: "Loan", entityId: loanId }, async () => {
    // TODO(af-servicing-statement): once lib/asset-finance/documents/statement-pdf.ts
    // exports renderEntityStatementPdf(tenantId, loanId), write the access with
    // logDocumentAccess (documentId = loanId, accessor = the client, "download"
    // when ?download=1) BEFORE rendering, then return its bytes as
    // application/pdf with Cache-Control "private, no-store" — exactly as
    // lib/vat/tax-invoice-serve.ts does. No bytes are served until then, so no
    // access row is written.
    return NextResponse.json({ error: "Statements for business contracts are not available yet" }, { status: 503 })
  })
}
