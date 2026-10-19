import { NextRequest, NextResponse } from "next/server"
import { withDealer } from "@/lib/dealer/guards"
import { readJsonBody, refusalResponse } from "@/lib/dealer/http"
import { attestDealerConsent } from "@/lib/dealer/consent"

type Params = { params: Promise<{ id: string }> }

/**
 * Attest the fixed consent statement (DEALER_CONSENT_STATEMENT) for each
 * person named, against a POPIA_CONSENT document this dealer uploaded on the
 * deal. `attested: true` is the dealer user's explicit confirmation. Evidence,
 * not consent: a staff member verifies it. Audited DEALER_CONSENT_ATTESTED.
 */
export async function POST(req: NextRequest, { params }: Params) {
  return withDealer(req, {}, async (actor) => {
    const { id } = await params
    const body = (await readJsonBody(req)) as { attested?: unknown; documentId?: unknown; clientIds?: unknown } | null
    if (body?.attested !== true) return NextResponse.json({ error: "Confirm the consent statement" }, { status: 400 })
    const result = await attestDealerConsent(actor, id, { documentId: body.documentId, clientIds: body.clientIds })
    if (result.kind === "refused") return refusalResponse(result)
    return NextResponse.json({ attestationIds: result.attestationIds }, { status: 201 })
  })
}
