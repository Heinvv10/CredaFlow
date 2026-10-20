import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { refusalResponse } from "@/lib/dealer/http"
import { submitDealerDeal } from "@/lib/dealer/submit"

type Params = { params: Promise<{ id: string }> }

/**
 * Hand the draft to the lender: every person's consent attested and at least
 * one document uploaded. Records dealerSubmittedAt (the deal stays DRAFT until
 * a staff member accepts it). Audited DEALER_DEAL_SUBMITTED.
 */
export async function POST(req: NextRequest, { params }: Params) {
  return withDealer(req, {}, async (actor) => {
    const { id } = await params
    const result = await submitDealerDeal(actor, id)
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json({ dealerSubmittedAt: result.at.toISOString() })
  })
}
