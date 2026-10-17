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
import {
  arrearsGrowth, growthBeyondCap, MAX_ARREARS_GROWTH_INSTALMENTS, recordedExceptions, regularInstalmentCents, worsenedSince, type ArrearsGrowth,
} from "./deal-exception-severity"
import { formatMoney } from "./format"

export type CreditGateProblem =
  | { kind: "product_not_asset_finance"; message: string }
  | { kind: "exceptions_since_approval"; message: string; exceptions: string[] }

export interface CreditGate {
  problem: CreditGateProblem | null
  /** Answered arrears exceptions whose amount grew since approval, within the cap: not a refusal, the caller audits them. */
  arrearsGrown: (ArrearsGrowth & { regularInstalmentCents: number })[]
}

export async function dealCreditGate(tx: RegimeTx, tenantId: string, dealId: string): Promise<CreditGate> {
  const deal = await tx.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId },
    select: {
      applicationId: true, entityId: true, clientId: true, approvalExceptions: true,
      application: { select: { product: { select: { productType: true } } } },
    },
  })
  if (!deal) return { problem: null, arrearsGrown: [] }
  if (deal.application.product.productType !== "ASSET_FINANCE") {
    return { problem: { kind: "product_not_asset_finance", message: "The deal's product is not an asset-finance product" }, arrearsGrown: [] }
  }
  const found = await loadDealExceptions(tx, tenantId, deal)
  const approved = new Map(recordedExceptions(deal.approvalExceptions).map((e) => [e.key, e]))
  const problems = found.recorded.flatMap((current, i) => {
    const answered = approved.get(current.key)
    if (!answered) return [`${found.lines[i]} (new since approval)`]
    const worse = worsenedSince(answered, current)
    return worse ? [`${found.lines[i]} (worse since approval: ${worse})`] : []
  })
  const grown = found.recorded.flatMap((current, i) => {
    const answered = approved.get(current.key)
    const growth = answered && arrearsGrowth(answered, current)
    return growth ? [{ growth, line: found.lines[i] }] : []
  })
  const loanIds = grown.map((g) => g.growth.key.replace(/^ARREARS:/, ""))
  const rows = loanIds.length === 0 ? [] : await tx.repaymentSchedule.findMany({
    where: { tenantId, loanId: { in: loanIds } }, select: { loanId: true, totalDue: true },
  })
  const arrearsGrown: CreditGate["arrearsGrown"] = []
  for (const { growth, line } of grown) {
    const regular = regularInstalmentCents(rows.filter((r) => `ARREARS:${r.loanId}` === growth.key).map((r) => r.totalDue))
    if (growthBeyondCap(growth, regular)) {
      problems.push(`${line} (worse since approval: its arrears grew by ${formatMoney(growth.currentArrearsCents - growth.approvedArrearsCents)}, `
        + `more than ${MAX_ARREARS_GROWTH_INSTALMENTS} regular instalments of ${formatMoney(regular)})`)
    } else {
      arrearsGrown.push({ ...growth, regularInstalmentCents: regular })
    }
  }
  if (problems.length === 0) return { problem: null, arrearsGrown }
  return {
    problem: {
      kind: "exceptions_since_approval",
      message: `Not answered by the deal's approval: ${problems.join("; ")}. Resolve it or cancel the deal.`,
      exceptions: problems,
    },
    arrearsGrown,
  }
}
