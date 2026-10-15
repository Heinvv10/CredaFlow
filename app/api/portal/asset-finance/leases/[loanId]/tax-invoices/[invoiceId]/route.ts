import { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { withPortalLeaseDocument, portalLeaseNotFound } from "@/lib/asset-finance/lease-portal-route"
import { serveTaxInvoicePdf } from "@/lib/vat/tax-invoice-serve"

type Params = { params: Promise<{ loanId: string; invoiceId: string }> }

/**
 * A lease's tax invoice (a rental's, or an end-of-term or termination
 * invoice) as a PDF (`?download=1` as an attachment), for the lessee or a
 * client with authority over the lessee entity (lib/asset-finance/
 * lease-portal-route.ts). The invoice must be the lease's. The read is logged
 * in DocumentAccessLog against the invoice id before rendering.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { loanId, invoiceId } = await params
  return withPortalLeaseDocument(req, loanId, { entity: "TaxInvoice", entityId: invoiceId }, async ({ tenantId, client }) => {
    const owned = await prisma.taxInvoice.findFirst({ where: { id: invoiceId, tenantId, loanId }, select: { id: true } })
    if (!owned) return portalLeaseNotFound()
    const response = await serveTaxInvoicePdf(prisma, req, { tenantId, invoiceId }, { type: "client", id: client.clientId })
    return response ?? portalLeaseNotFound()
  })
}
