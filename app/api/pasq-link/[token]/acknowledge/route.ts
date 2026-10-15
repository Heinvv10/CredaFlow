import { type NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { checkRateLimit, callerIp, recordedCallerIp } from "@/lib/rate-limit"
import { recordPasqAcknowledgement } from "@/lib/compliance/pasq-acknowledgement.server"
import {
  PASQ_LINK_REJECTION_MESSAGE,
  resolvePasqLinkToken,
} from "@/lib/compliance/pasq-link-token.server"
import { portalOffRefusal } from "@/lib/portal/portal-policy"

type RouteCtx = { params: Promise<{ token: string }> }

const ACK_LIMIT = { limit: 10, windowMs: 10 * 60 * 1000 }

/**
 * Consumer acknowledgement of the quotation through a one-time link.
 *
 * The evidence written is identical to the portal's — same writer, same
 * actorType, same prior-view requirement — because it is the same legal act
 * (NCA s.92(1)). The channel only adds descriptive fields to the audit row.
 */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const { token } = await params
  const ip = callerIp(req)
  if (!checkRateLimit(`pasq-link:ack:${ip}`, ACK_LIMIT).allowed) {
    return Response.json(
      { error: "Too many requests. Please wait a moment and try again." },
      { status: 429 },
    )
  }

  const resolved = await resolvePasqLinkToken(token)
  if (!resolved.ok) {
    return Response.json(
      { error: PASQ_LINK_REJECTION_MESSAGE[resolved.reason] },
      { status: resolved.reason === "unknown" || resolved.reason === "malformed" ? 404 : 410 },
    )
  }
  const { link } = resolved
  // The lender switched its portal off: its borrower-facing links close too.
  const portalOff = await portalOffRefusal(link.tenantId)
  if (portalOff) return portalOff

  const result = await recordPasqAcknowledgement({
    tenantId: link.tenantId,
    applicationId: link.applicationId,
    documentSha256: link.documentSha256,
    clientId: link.clientId,
    clientEmail: link.clientEmail,
    method: "token_link",
    ipAddress: recordedCallerIp(req),
    userAgent: req.headers.get("user-agent") ?? null,
    auditEvidence: {
      tokenId: link.tokenId,
      channel: link.channel,
    },
  })
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status })
  }

  // Burn the token only once the acknowledgement is on record. Marking it used
  // first would let a failed write strand the consumer with a dead link and no
  // acknowledgement. A second attempt after success is caught by the
  // already-acknowledged branch in the writer, so this cannot double-record.
  await prisma.pasqAcknowledgementToken.updateMany({
    where: { id: link.tokenId, tenantId: link.tenantId, usedAt: null },
    data: { usedAt: new Date() },
  })

  return Response.json({
    success: true,
    acknowledgedAt: result.acknowledgedAt,
    ...(result.existing ? { existing: true } : {}),
  })
}
