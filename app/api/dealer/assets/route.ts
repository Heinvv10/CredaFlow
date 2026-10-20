import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { captureResponse, readJsonBody } from "@/lib/dealer/http"
import { captureDealerAsset } from "@/lib/dealer/capture"
import { listDealerAssets } from "@/lib/dealer/captures"

/** The assets this dealer captured. */
export async function GET(req: NextRequest) {
  return withDealer(req, {}, async (actor) => NextResponse.json(await listDealerAssets(actor)))
}

/**
 * Register an asset as the dealer (createdByDealerId), through the staff
 * create code: VAT at the rate in force today; a serial or VIN already
 * financed and not released is 409. Audited ASSET_CREATED.
 */
export async function POST(req: NextRequest) {
  return withDealer(req, {}, async (actor) => captureResponse("asset", await captureDealerAsset(actor, await readJsonBody(req))))
}
