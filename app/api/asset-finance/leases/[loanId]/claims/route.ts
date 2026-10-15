import { NextRequest } from "next/server"
import { badRequest, cents, leaseStaffAction, text } from "@/lib/asset-finance/lease-route"
import { submitMaintenanceClaim } from "@/lib/asset-finance/maintenance-claims"

type Params = { params: Promise<{ loanId: string }> }

/**
 * Submit a maintenance claim against a full-maintenance lease's fund
 * (manage_asset_finance). Body: `{ supplierId, providerInvoiceDocumentId,
 * amountExclVatCents, description, meterReadingId? }`.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return leaseStaffAction(req, { loanId, permission: "manage_asset_finance", action: "claim_submit" }, (tx, actor, today, body) => {
    const supplierId = text(body, "supplierId")
    const providerInvoiceDocumentId = text(body, "providerInvoiceDocumentId")
    const amountExclVatCents = cents(body, "amountExclVatCents")
    const description = text(body, "description")
    if (!supplierId || !providerInvoiceDocumentId || amountExclVatCents === null || !description) {
      return Promise.resolve(badRequest("claim", "supplierId, providerInvoiceDocumentId, amountExclVatCents and description are required"))
    }
    return submitMaintenanceClaim(tx, actor, {
      loanId, supplierId, providerInvoiceDocumentId, amountExclVatCents, description, meterReadingId: text(body, "meterReadingId"), today,
    })
  })
}
