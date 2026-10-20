import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { captureResponse, readJsonBody } from "@/lib/dealer/http"
import { captureDealerPerson } from "@/lib/dealer/capture"
import { listDealerPeople } from "@/lib/dealer/captures"

/** The people this dealer captured. */
export async function GET(req: NextRequest) {
  return withDealer(req, {}, async (actor) => NextResponse.json(await listDealerPeople(actor)))
}

/** A sole proprietor captured by the dealer (a minimal Client). Audited CLIENT_CREATED. */
export async function POST(req: NextRequest) {
  return withDealer(req, {}, async (actor) => captureResponse("person", await captureDealerPerson(actor, await readJsonBody(req), null)))
}
