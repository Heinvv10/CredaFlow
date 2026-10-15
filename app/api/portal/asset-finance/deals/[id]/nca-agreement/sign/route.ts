import { NextRequest, NextResponse } from "next/server"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { parseSignatureInput, requestIp } from "@/lib/asset-finance/signing-esign"
import { signAssetNcaAgreement } from "@/lib/asset-finance/nca-agreement-store"
import { signingOtpChallengeIdFrom, signingOtpRefusal } from "@/lib/signing-otp/policy"

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    const body: unknown = await req.json().catch(() => null)
    const input = parseSignatureInput(body)
    if ("error" in input) return NextResponse.json({ error: input.error }, { status: input.status })
    const result = await signAssetNcaAgreement({
      tenantId, clientId: client.clientId, clientEmail: client.email, dealId: id,
      signature: input.signature, documentSha256: input.documentSha256, ip: requestIp(req),
      signingOtpChallengeId: signingOtpChallengeIdFrom(body),
    })
    if (result.kind === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 })
    if (result.kind === "not_ready") return NextResponse.json({ error: result.reason }, { status: 409 })
    if (result.kind === "signing_otp") return signingOtpRefusal(result.reason)
    return NextResponse.json(result)
  })
}
