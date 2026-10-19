import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { dealerSupplierChoices } from "@/lib/dealer/deals"

/** The lender's active suppliers (id and name only), the dealer's own linked supplier as the default. */
export async function GET(req: NextRequest) {
  return withDealer(req, {}, async (actor) => NextResponse.json(await dealerSupplierChoices(actor)))
}
