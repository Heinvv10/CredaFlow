import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { dealerProductChoices } from "@/lib/dealer/deals"

/** The lender's active asset-finance products a dealer deal may use. */
export async function GET(req: NextRequest) {
  return withDealer(req, {}, async (actor) => NextResponse.json(await dealerProductChoices(actor)))
}
