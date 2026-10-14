import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { checkRateLimit } from "@/lib/rate-limit"
import { withPortalEntity } from "@/lib/asset-finance/portal-route"
import { portalSignerAuthorityWhere } from "@/lib/asset-finance/portal-access"
import { PORTAL_SIGN_RATE_LIMIT } from "@/lib/asset-finance/portal-rate-limits"
import { parseSignatureInput, recordESignature, requestIp } from "@/lib/asset-finance/signing-esign"
import { signingErrorResponse } from "@/lib/asset-finance/signing-route"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { signingOtpChallengeIdFrom, signingOtpRefusal } from "@/lib/signing-otp/policy"

/**
 * E-sign the client's own deal document. Body `{ signature, documentSha256,
 * signingOtpChallengeId }`: a drawn PNG data URL or a typed name, the digest
 * the sign page showed, and the signing code verified for this signer row and
 * those bytes when the lender requires one (403/409 `signingOtp` otherwise).
 * 404 for anyone else's signer row, and for the client's own row once they no
 * longer hold the relationship that authorises it (portalSignerAuthorityWhere);
 * 409 when it is signed already, the deal is not open for signing, or the
 * document changed since it was shown; 429 past PORTAL_SIGN_RATE_LIMIT.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ signerId: string }> }) {
  const { signerId } = await params
  return withPortalEntity(req, null, async ({ tenantId, client }) => {
    const gate = checkRateLimit(`portal:af-sign:${tenantId}:${client.clientId}`, PORTAL_SIGN_RATE_LIMIT)
    if (!gate.allowed) {
      return NextResponse.json(
        { error: "Too many signing attempts. Please wait a few minutes and try again." },
        { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
      )
    }
    const body: unknown = await req.json().catch(() => null)
    const input = parseSignatureInput(body)
    if ("error" in input) return NextResponse.json({ error: input.error }, { status: input.status })
    const authorised = await prisma.dealSigner.findFirst({
      where: { id: signerId, tenantId, clientId: client.clientId, AND: [portalSignerAuthorityWhere(tenantId, client.clientId)] },
      select: { id: true },
    })
    if (!authorised) return NextResponse.json({ error: "Not found" }, { status: 404 })
    let result: Awaited<ReturnType<typeof recordESignature>>
    try {
      result = await recordESignature({
        tenantId, clientId: client.clientId, clientEmail: client.email, signerId, input, ip: requestIp(req),
        signingOtpChallengeId: signingOtpChallengeIdFrom(body),
      })
    } catch (error) {
      const mapped = signingErrorResponse(error)
      if (mapped) return mapped
      throw error
    }
    const refuse = async (reason: string, error: string) => {
      await auditRefusal({
        action: AuditAction.ASSET_DEAL_SIGNING_REFUSED,
        entity: "DealSigner",
        entityId: signerId,
        tenantId,
        userEmail: client.email,
        reason,
        status: 409,
        detail: { clientId: client.clientId },
      })
      return NextResponse.json({ error }, { status: 409 })
    }
    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Not found" }, { status: 404 })
      case "not_signable":
        return refuse("not_signable", result.reason)
      case "stale_view":
        return refuse("stale_view", "The document was replaced after you opened it; reload the page and read it again")
      case "document_changed":
        return refuse("document_changed", "This deal changed after its documents were prepared, so they cannot be signed; contact the lender")
      case "signing_otp":
        return signingOtpRefusal(result.reason)
      case "signed":
        return NextResponse.json({ signerId, signedAt: result.signedAt.toISOString() })
    }
  })
}
