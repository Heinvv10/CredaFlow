import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { withPortalLoanDocument, portalLoanNotFound } from "@/lib/asset-finance/portal-loan-route"
import { findLoanTaxInvoiceId } from "@/lib/asset-finance/portal-contract"
import { serveTaxInvoicePdf } from "@/lib/vat/tax-invoice-serve"

type Params = { params: Promise<{ loanId: string }> }

/**
 * The contract's inception tax invoice as a PDF (`?download=1` as an
 * attachment) for a client with authority over the loan's entity. The read
 * is logged in DocumentAccessLog against the invoice id before rendering.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return withPortalLoanDocument(req, loanId, { entity: "Loan", entityId: loanId }, async ({ tenantId, client }) => {
    const invoiceId = await findLoanTaxInvoiceId(tenantId, loanId)
    if (!invoiceId) return portalLoanNotFound()
    const response = await serveTaxInvoicePdf(prisma, req, { tenantId, invoiceId }, { type: "client", id: client.clientId })
    return response ?? portalLoanNotFound()
  })
}
