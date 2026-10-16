import { NextRequest, NextResponse } from "next/server"
import QRCode from "qrcode"
import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { checkRateLimit } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { requirePortalBaseUrl } from "@/lib/config/deployment-urls"
import { mintSelfieLinkToken } from "@/lib/kyc/selfie-link-token.server"

/** Mirrors CAPTURABLE_STATUSES in lib/kyc/selfie-link-token.server.ts. */
const CAPTURABLE_STATUSES = ["SUBMITTED", "UNDER_REVIEW", "APPROVED"] as const
const HANDOFF_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 } as const

/** Same origin rule as the staff send-link route (app/api/applications/[id]/selfie/send-link). */
function portalOrigin(): string {
  return (
    process.env.PORTAL_PUBLIC_ORIGIN
    ?? process.env.NEXT_PUBLIC_PORTAL_ORIGIN
    ?? requirePortalBaseUrl()
  ).replace(/\/+$/, "")
}

/**
 * "Continue on your phone": the signed-in client, on a device with no camera,
 * gets the same one-time 24h capture link staff send (lib/kyc/
 * selfie-link-token.server.ts), returned to them as a link and a QR code to
 * scan, instead of being messaged. Bound to the client's own application that
 * still awaits a photo; minting it cancels any earlier link for that
 * application, as a resend by staff does.
 */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if ((session.user.role as string) !== "CLIENT") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const gate = checkRateLimit(`portal-selfie-handoff:${session.user.id}`, HANDOFF_RATE_LIMIT)
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds ?? 60) } },
    )
  }

  return withTenantContext(req, async (tenant) => {
    const application = await prisma.loanApplication.findFirst({
      where: { tenantId: tenant.id, clientId: session.user.id, status: { in: [...CAPTURABLE_STATUSES] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, clientId: true },
    })
    if (!application?.clientId) {
      return NextResponse.json({ error: "You have no application waiting for a photo." }, { status: 409 })
    }
    const clientId = application.clientId

    let result
    try {
      result = await prisma.$transaction(async (tx) => {
        // The live links this one cancels (one live link per application),
        // read in the same transaction as the cancellation so the audit names them.
        const live = await tx.selfieCaptureToken.findMany({
          where: { tenantId: tenant.id, applicationId: application.id, usedAt: null, invalidatedAt: null },
          select: { id: true, channel: true },
        })
        const token = await mintSelfieLinkToken(tx, {
          tenantId: tenant.id,
          applicationId: application.id,
          clientId,
          channel: "PORTAL",
          sentTo: "portal",
          createdById: null,
        })
        return { minted: token, replaced: live }
      })
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        return NextResponse.json({ error: "A link is already being created. Try again in a moment." }, { status: 409 })
      }
      throw error
    }
    const { minted, replaced } = result

    const url = `${portalOrigin()}/selfie/${minted.secret}`
    await logAudit({
      tenantId: tenant.id,
      userEmail: session.user.email ?? undefined,
      action: AuditAction.SELFIE_LINK_PORTAL_HANDOFF,
      entity: "LoanApplication",
      entityId: application.id,
      // The URL secret is never logged: an audit reader must not be able to
      // capture on the client's behalf.
      newValue: { tokenId: minted.id, clientId, channel: "PORTAL", expiresAt: minted.expiresAt.toISOString() },
    })
    if (replaced.length > 0) {
      await logAudit({
        tenantId: tenant.id,
        userEmail: session.user.email ?? undefined,
        action: AuditAction.SELFIE_LINK_INVALIDATED,
        entity: "LoanApplication",
        entityId: application.id,
        newValue: { reason: "superseded_by_portal_handoff", tokenIds: replaced.map((t) => t.id), channels: replaced.map((t) => t.channel), replacedBy: minted.id },
      })
    }

    const qr = await QRCode.toDataURL(url, { margin: 1, width: 240 })
    return NextResponse.json({ url, qr, expiresAt: minted.expiresAt, replacedEarlierLink: replaced.length > 0 })
  })
}
