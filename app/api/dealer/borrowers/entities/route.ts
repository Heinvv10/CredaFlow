import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { captureResponse, readJsonBody } from "@/lib/dealer/http"
import { captureDealerEntity } from "@/lib/dealer/capture"
import { listDealerEntities } from "@/lib/dealer/captures"

/** The business entities this dealer captured, with the people it added to them. */
export async function GET(req: NextRequest) {
  return withDealer(req, {}, async (actor) => NextResponse.json(await listDealerEntities(actor)))
}

/**
 * Capture a business entity as the dealer (createdByDealerId). One already on
 * the lender's book is 409 and shows nothing of it. Audited
 * BUSINESS_ENTITY_CREATED with the dealer actor.
 */
export async function POST(req: NextRequest) {
  return withDealer(req, {}, async (actor) => captureResponse("entity", await captureDealerEntity(actor, await readJsonBody(req))))
}
