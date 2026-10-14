import { NextRequest, NextResponse } from "next/server"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { parseSignatureInput, requestIp } from "@/lib/asset-finance/signing-esign"
import { signAssetNcaAgreement } from "@/lib/asset-finance/nca-agreement-store"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    const input = parseSignatureInput(await req.json().catch(() => null))
    if ("error" in input) return NextResponse.json({ error: input.error }, { status: input.status })
    const result = await signAssetNcaAgreement({
      tenantId, clientId: client.clientId, clientEmail: client.email, dealId: id,
      signature: input.signature, documentSha256: input.documentSha256, ip: requestIp(req),
    })
    if (result.kind === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    return NextResponse.json(result)
  })
}
