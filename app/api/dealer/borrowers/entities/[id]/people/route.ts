import { NextRequest } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { captureResponse, readJsonBody } from "@/lib/dealer/http"
import { captureDealerPerson } from "@/lib/dealer/capture"

type Params = { params: Promise<{ id: string }> }

/**
 * A new person (director, member, trustee, signatory, surety, owner) of one
 * of this dealer's own entities: a minimal Client the dealer captures, linked
 * in its roles. Another entity is 404; a person already on the lender's book
 * 409. Audited CLIENT_CREATED and ENTITY_RELATIONSHIP_ADDED.
 */
export async function POST(req: NextRequest, { params }: Params) {
  return withDealer(req, {}, async (actor) => {
    const { id } = await params
    return captureResponse("person", await captureDealerPerson(actor, await readJsonBody(req), id))
  })
}
