import { NextRequest } from "next/server"
import { badRequest, leasePortalAction } from "@/lib/asset-finance/lease-route"
import { electEndOfTerm } from "@/lib/asset-finance/lease-end-of-term"
import { bestMarketValuation } from "@/lib/asset-finance/lease-term-end"

type Params = { params: Promise<{ loanId: string }> }

/**
 * The lessee chooses the end-of-term option when it is offered: `{ outcome:
 * RETURN | EXTEND | PURCHASE }`. A purchase is at market value: the highest
 * current assessor's or dealer's valuation of the asset
 * (lib/asset-finance/lease-term-end.ts); without one the option is not offered.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { loanId } = await params
  return leasePortalAction(req, loanId, "portal_end_of_term", async (tx, actor, today, body) => {
    const outcome = (["RETURN", "EXTEND", "PURCHASE"] as const).find((o) => o === body.outcome)
    if (!outcome) return badRequest("outcome", "outcome must be RETURN, EXTEND or PURCHASE")
    if (outcome !== "PURCHASE") return electEndOfTerm(tx, actor, { loanId, outcome, today })
    const loan = await tx.loan.findFirst({ where: { id: loanId, tenantId: actor.tenantId }, select: { assetId: true } })
    const valuation = loan?.assetId ? await bestMarketValuation(tx, actor.tenantId, loan.assetId, today) : null
    if (!valuation) return { kind: "refused", reason: "valuation", error: "The purchase option needs a current valuation of the asset; ask the lessor" }
    return electEndOfTerm(tx, actor, { loanId, outcome, today, purchase: { priceExclVatCents: valuation.amountCents, valuationId: valuation.id } })
  })
}
