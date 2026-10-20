import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { invalidResponse, readJsonBody, refusalResponse } from "@/lib/dealer/http"
import { createDealerDeal } from "@/lib/dealer/deals"
import { listDealerDeals } from "@/lib/dealer/deal-view"

/** This dealer's deals, newest first, as the dealer may see them. */
export async function GET(req: NextRequest) {
  return withDealer(req, {}, async (actor) => NextResponse.json(await listDealerDeals(actor)))
}

/**
 * A draft deal through the unchanged createDeal: the borrower and asset must
 * be this dealer's captures (404 otherwise), the supplier one of the lender's
 * (the dealer's linked supplier by default). Audited with the dealer actor.
 */
export async function POST(req: NextRequest) {
  return withDealer(req, {}, async (actor) => {
    const result = await createDealerDeal(actor, await readJsonBody(req))
    if (result.kind === "invalid") return invalidResponse("deal", result.fields)
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json({ id: result.dealId }, { status: 201 })
  })
}
