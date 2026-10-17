/**
 * What the credit decision approved must still hold when the money moves
 * (Fair Score audit E4/E5): payout creation (./payout.ts) and booking
 * (./booking-load.ts) re-run the internal default cross-check and refuse an
 * exception the approval did not answer, or one that has got worse since
 * (approvalExceptions; ./deal-exception-severity.ts), and
 * refuse a deal whose product is not an ASSET_FINANCE product. The database
 * holds the people fixed from approval (guardEntityRelationshipOnOpenDeal) and
 * the product kind (guardAssetDealProductKind); this catches what changed
 * outside them, such as a party's loan falling into arrears after approval.
 */
import type { RegimeTx } from "./classification"
import { loadDealExceptions } from "./deal-exceptions"
import { recordedExceptions, worsenedSince } from "./deal-exception-severity"

export type CreditGateProblem =
  | { kind: "product_not_asset_finance"; message: string }
  | { kind: "exceptions_since_approval"; message: string; exceptions: string[] }

export async function dealCreditGateProblem(tx: RegimeTx, tenantId: string, dealId: string): Promise<CreditGateProblem | null> {
  const deal = await tx.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId },
    select: {
      applicationId: true, entityId: true, clientId: true, approvalExceptions: true,
      application: { select: { product: { select: { productType: true } } } },
    },
  })
  if (!deal) return null
  if (deal.application.product.productType !== "ASSET_FINANCE") {
    return { kind: "product_not_asset_finance", message: "The deal's product is not an asset-finance product" }
  }
  const found = await loadDealExceptions(tx, tenantId, deal)
  const approved = new Map(recordedExceptions(deal.approvalExceptions).map((e) => [e.key, e]))
  const problems = found.recorded.flatMap((current, i) => {
    const answered = approved.get(current.key)
    if (!answered) return [`${found.lines[i]} (new since approval)`]
    const worse = worsenedSince(answered, current)
    return worse ? [`${found.lines[i]} (worse since approval: ${worse})`] : []
  })
  if (problems.length === 0) return null
  return {
    kind: "exceptions_since_approval",
    message: `Not answered by the deal's approval: ${problems.join("; ")}. Resolve it or cancel the deal.`,
    exceptions: problems,
  }
}
