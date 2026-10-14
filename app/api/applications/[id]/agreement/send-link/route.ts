import { NextResponse, type NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAudit } from "@/lib/audit"
import { sendSms, sendWhatsApp } from "@/lib/integrations/bulksms"
import { isSmsChannelEnabled, SMS_CHANNEL_OFF_REASON } from "@/lib/messaging/sms-channel"
import { sendEmail } from "@/lib/email/service"
import { getLenderIdentity } from "@/lib/config/identity"
import { escapeHtml } from "@/lib/utils"
import { portalContinueUrl } from "@/lib/portal-urls"
import { maskDestination } from "@/lib/compliance/pasq-link-token.server"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"

type RouteCtx = { params: Promise<{ id: string }> }

const E164 = /^\+[1-9]\d{7,14}$/
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Sends the consumer a link to sign their agreement over SMS, WhatsApp or email.
 *
 * Carries NO bearer credential, unlike the selfie capture link. A signature is
 * a legal act attributable to a person, and a click on a link proves nothing
 * about who clicked — so this routes through `/portal/continue`, which resolves
 * login-vs-register at CLICK time and carries the destination through
 * registration. The consumer authenticates; only then do they sign.
 */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = (await req.json().catch(() => null)) as { channel?: unknown } | null
    const channel = body?.channel
    if (channel !== "SMS" && channel !== "WHATSAPP" && channel !== "EMAIL") {
      return NextResponse.json(
        { error: "channel must be 'SMS', 'WHATSAPP' or 'EMAIL'" },
        { status: 400 },
      )
    }
    // SMS channel off (BULKSMS_DRY_RUN). Refuse rather than dispatch a leg
    // that can only produce a SIMULATED record and an audit row reading as if
    // the consumer was sent the signing link.
    //
    // This route has NO UI caller at all — grep for "agreement/send-link"
    // finds only this file and its test, so every request is a direct call.
    // Nothing here consults getChannelAvailability, which serves the inbox
    // composer rather than the send-link surfaces. This 400 is the control.
    if (channel === "SMS" && !isSmsChannelEnabled()) {
      return NextResponse.json(
        { error: `${SMS_CHANNEL_OFF_REASON} — send the link over WhatsApp or email instead.` },
        { status: 400 },
      )
    }

    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        id: true,
        reference: true,
        agreementGeneratedAt: true,
        agreementSignedAt: true,
        client: {
          select: { firstName: true, lastName: true, email: true, phone: true, whatsapp: true },
        },
      },
    })
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    // The signing link goes to a consumer; an entity borrower is refused.
    if (!hasClientBorrower(application)) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    if (!application.agreementGeneratedAt) {
      return NextResponse.json({
        error: "Generate the agreement before sending the consumer a signing link.",
      }, { status: 409 })
    }
    if (application.agreementSignedAt) {
      return NextResponse.json({
        error: "The consumer has already signed this agreement.",
      }, { status: 409 })
    }

    // The destination is ALWAYS the contact on the client record — never a
    // per-send override, for the same reason as every other consumer link:
    // a staff-chosen destination lets one account drive the consumer's side of
    // the ceremony. `body.to` is deliberately never read.
    const client = application.client
    const sentTo = channel === "EMAIL"
      ? client.email
      : channel === "WHATSAPP"
        ? client.whatsapp ?? client.phone
        : client.phone
    if (channel === "EMAIL") {
      if (!sentTo || !EMAIL_SHAPE.test(sentTo)) {
        return NextResponse.json({
          error: "The client record has no valid email address. Correct the client's contact details first — the signing link is only ever sent to the address on file.",
        }, { status: 422 })
      }
    } else if (!sentTo || !E164.test(sentTo)) {
      return NextResponse.json({
        error: "The client record has no valid E.164 number for this channel. Correct the client's contact details first — the signing link is only ever sent to the number on file.",
      }, { status: 422 })
    }

    // portalContinueUrl resolves login-vs-register at click time and validates
    // `next` through safePortalPath, so the destination cannot become an
    // open-redirect sink. It also targets the client host — a staff-origin link
    // would work silently while putting the consumer on the wrong container.
    const url = portalContinueUrl(
      client.email ?? "",
      application.reference,
      `/portal/agreement/${application.id}`,
    )
    // Fails closed: an unconfigured identity aborts the send.
    const identity = await getLenderIdentity(tenant.id)
    const message =
      `${identity.tradingName}: your loan agreement is ready to sign. Open it here: ${url}`

    let delivery: { ok: boolean; simulated?: boolean; error?: string; providerOutcome?: string }
    if (channel === "EMAIL") {
      const clientName = [client.firstName, client.lastName].filter(Boolean).join(" ")
      const emailResult = await sendEmail({
        tenantId: tenant.id,
        to: sentTo,
        toName: clientName || undefined,
        subject: "Your loan agreement is ready to sign",
        html: [
          `<p>Good day${clientName ? ` ${escapeHtml(clientName)}` : ""},</p>`,
          "<p>Your loan agreement is ready for your signature.</p>",
          `<p><a href="${url}">${url}</a></p>`,
          "<p>You will be asked to sign in (or set a password if this is your first visit) before you can sign.</p>",
          `<p>${escapeHtml(identity.tradingName)}</p>`,
        ].join("\n"),
        text: message,
        category: "agreement-signing-link",
        referenceId: application.id,
      })
      delivery = {
        ok: emailResult.ok,
        error: emailResult.error,
        providerOutcome: emailResult.providerOutcome,
      }
    } else {
      delivery = channel === "WHATSAPP"
        ? await sendWhatsApp({ tenantId: tenant.id, to: sentTo, message })
        : await sendSms({ tenantId: tenant.id, to: sentTo, message })
    }

    // Nothing is cancelled on failure the way a capture token is: this link
    // carries no credential, so an undelivered message leaves nothing live
    // behind. The audit records the true provider verdict either way.
    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: delivery.ok
        ? AuditAction.AGREEMENT_SIGNING_LINK_SENT
        : AuditAction.AGREEMENT_SIGNING_LINK_SEND_FAILED,
      entity: "LoanApplication",
      entityId: application.id,
      ipAddress: req.headers.get("x-forwarded-for") ?? undefined,
      newValue: {
        signingLinkSent: delivery.ok,
        channel,
        sentTo: maskDestination(sentTo),
        simulated: delivery.simulated ?? false,
        ...(delivery.ok ? {} : {
          failure: delivery.error ?? "send_failed",
          possiblyDelivered: delivery.providerOutcome !== undefined
            && delivery.providerOutcome !== "DEFINITELY_REJECTED",
        }),
      },
    })

    if (!delivery.ok) {
      return NextResponse.json({
        error: "The signing link could not be delivered. Check the contact details and try again.",
        deliveryError: delivery.error ?? "send_failed",
      }, { status: 502 })
    }
    return NextResponse.json({
      success: true,
      channel,
      sentTo: maskDestination(sentTo),
      simulated: delivery.simulated ?? false,
    })
  })
}
