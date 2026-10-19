import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { loadDealerCommissionStatement } from "@/lib/dealer/commission-statement"

/** This dealer's commission lines and payable runs, read-only. */
export async function GET(req: NextRequest) {
  return withDealer(req, {}, async (actor) => NextResponse.json(await loadDealerCommissionStatement(actor)))
}
