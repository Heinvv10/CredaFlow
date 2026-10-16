/**
 * What the credit decision approved must still hold when the money moves
 * (Fair Score audit E4/E5): payout creation (./payout.ts) and booking
 * (./booking-load.ts) re-run the internal default cross-check and refuse an
 * exception the approval did not answer (its approvalExceptionKeys), and
 * refuse a deal whose product is not an ASSET_FINANCE product. The database
 * holds the people fixed from approval (guardEntityRelationshipOnOpenDeal) and
 * the product kind (guardAssetDealProductKind); this catches what changed
 * outside them, such as a party's loan falling into arrears after approval.
 */
import type { RegimeTx } from "./classification"
import { loadDealExceptions } from "./deal-exceptions"

export type CreditGateProblem =
  | { kind: "product_not_asset_finance"; message: string }
  | { kind: "exceptions_since_approval"; message: string; exceptions: string[] }

export async function dealCreditGateProblem(tx: RegimeTx, tenantId: string, dealId: string): Promise<CreditGateProblem | null> {
  const deal = await tx.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId },
    select: {
      applicationId: true, entityId: true, clientId: true, approvalExceptionKeys: true,
      application: { select: { product: { select: { productType: true } } } },
    },
  })
  if (!deal) return null
  if (deal.application.product.productType !== "ASSET_FINANCE") {
    return { kind: "product_not_asset_finance", message: "The deal's product is not an asset-finance product" }
  }
  const found = await loadDealExceptions(tx, tenantId, deal)
  const approved = new Set(deal.approvalExceptionKeys)
  const added = found.lines.filter((_, i) => !approved.has(found.keys[i]))
  if (added.length === 0) return null
  return {
    kind: "exceptions_since_approval",
    message: `New since the deal was approved, and not answered by the approval: ${added.join("; ")}. Resolve it or cancel the deal.`,
    exceptions: added,
  }
}
