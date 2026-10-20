import { NextResponse, type NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { DEALER_CONTACT_UNVERIFIED, dealerContactUnverified } from "@/lib/clients/dealer-contact"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAudit } from "@/lib/audit"
import { recordedCallerIp } from "@/lib/rate-limit"
import { sendSms, sendWhatsApp } from "@/lib/integrations/bulksms"
import { isSmsChannelEnabled, SMS_CHANNEL_OFF_REASON } from "@/lib/messaging/sms-channel"
import { sendEmail } from "@/lib/email/service"
import { getLenderIdentity } from "@/lib/config/identity"
import { requirePortalBaseUrl } from "@/lib/config/deployment-urls"
import { escapeHtml } from "@/lib/utils"
import { maskDestination } from "@/lib/compliance/pasq-link-token.server"
import {
  mintSelfieLinkToken,
  type SelfieLinkChannel,
} from "@/lib/kyc/selfie-link-token.server"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"

type RouteCtx = { params: Promise<{ id: string }> }

const E164 = /^\+[1-9]\d{7,14}$/
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Mirrors CAPTURABLE_STATUSES in lib/kyc/selfie-link-token.server.ts. Sending
 * a link for an application the resolver would refuse only wastes the
 * consumer's time. */
const CAPTURABLE_STATUSES = new Set(["SUBMITTED", "UNDER_REVIEW", "APPROVED"])

/**
 * The portal origin. Duplicated from the PASQ send-link route rather than
 * imported from lib/portal-urls: that module derives its base
 * from NEXT_PUBLIC_* build args, while these server-side link routes resolve
 * PORTAL_PUBLIC_ORIGIN first so a run-time env change takes effect without a
 * rebuild. Keeping the two send-link routes identical matters more than
 * removing six lines.
 */
function portalOrigin(): string {
  return (
    process.env.PORTAL_PUBLIC_ORIGIN
    ?? process.env.NEXT_PUBLIC_PORTAL_ORIGIN
    ?? requirePortalBaseUrl()
  ).replace(/\/+$/, "")
}

/**
 * Sends the consumer a one-time link that opens a KYC selfie capture bound to
 * ONE application, without requiring a portal account.
 *
 * Same role floor as the PASQ link (CREDIT_OFFICER or higher): a consultant
 * working the deal drives this, and escalating every capture to an admin would
 * simply mean it never gets used.
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
    // the consumer was sent the capture link.
    //
    // The staff UI that calls this (components/applications/SelfieLinkSection)
    // does not render the SMS button when the channel is off, so a request
    // arriving here with channel=SMS is a stale tab or a direct call. That is
    // the UI's own gate, NOT getChannelAvailability — which serves the inbox
    // composer and is not consulted by any send-link surface. This 400 is the
    // control; the hidden button is only so staff never meet it.
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
        clientId: true,
        status: true,
        client: {
          select: { firstName: true, lastName: true, email: true, phone: true, whatsapp: true, createdByDealerId: true, dealerContactVerifiedAt: true },
        },
      },
    })
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    // Selfie KYC is for a natural person; an entity borrower is refused.
    if (!hasClientBorrower(application)) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    if (!CAPTURABLE_STATUSES.has(application.status)) {
      return NextResponse.json({
        error: "This application is no longer awaiting a photo.",
      }, { status: 409 })
    }

    // Contact details a dealer typed may be the dealer's own: nothing goes to
    // them until a staff member verifies them (lib/clients/dealer-contact.ts).
    if (dealerContactUnverified(application.client)) {
      return NextResponse.json({ error: DEALER_CONTACT_UNVERIFIED }, { status: 409 })
    }

    // The destination is ALWAYS the contact on the client record — never a
    // per-send override. This link produces consumer KYC evidence; letting
    // staff redirect it to an arbitrary number would let a single account
    // manufacture that evidence by sending the link to itself. `body.to` is
    // deliberately never read. A wrong number is fixed on the client record
    // (its own audited workflow).
    const client = application.client
    const sentTo = channel === "EMAIL"
      ? client.email
      : channel === "WHATSAPP"
        ? client.whatsapp ?? client.phone
        : client.phone
    if (channel === "EMAIL") {
      if (!sentTo || !EMAIL_SHAPE.test(sentTo)) {
        return NextResponse.json({
          error: "The client record has no valid email address. Correct the client's contact details first — the capture link is only ever sent to the address on file.",
        }, { status: 422 })
      }
    } else if (!sentTo || !E164.test(sentTo)) {
      return NextResponse.json({
        error: "The client record has no valid E.164 number for this channel. Correct the client's contact details first — the capture link is only ever sent to the number on file.",
      }, { status: 422 })
    }

    // Invalidate-then-create must be one transaction, and the partial unique
    // index (one active token per application) makes the invariant a database
    // fact: a concurrent resend loses with a unique violation, never with two
    // live links.
    // Before minting, so an unconfigured identity leaves no orphaned link.
    const identity = await getLenderIdentity(tenant.id)
    let minted
    try {
      minted = await prisma.$transaction((tx) => mintSelfieLinkToken(tx, {
        tenantId: tenant.id,
        applicationId: application.id,
        clientId: application.clientId,
        channel: channel as SelfieLinkChannel,
        sentTo,
        createdById: guard.user.id,
      }))
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        return NextResponse.json({
          error: "Another capture link is being sent for this application. Wait a moment and check before resending.",
        }, { status: 409 })
      }
      throw error
    }

    const url = `${portalOrigin()}/selfie/${minted.secret}`
    const message =
      `${identity.tradingName}: please take a quick photo of your face so we can verify `
      + `your identity: ${url} (link expires in 24 hours).`

    let delivery: { ok: boolean; simulated?: boolean; error?: string; providerOutcome?: string }
    if (channel === "EMAIL") {
      const clientName = [client.firstName, client.lastName].filter(Boolean).join(" ")
      const emailResult = await sendEmail({
        tenantId: tenant.id,
        to: sentTo,
        toName: clientName || undefined,
        subject: "A quick photo to verify your identity",
        html: [
          `<p>Good day${clientName ? ` ${escapeHtml(clientName)}` : ""},</p>`,
          "<p>To finish verifying your identity we need a photo of your face, which we compare against the photograph on your ID document.</p>",
          `<p><a href="${url}">${url}</a></p>`,
          "<p>The link expires in 24 hours and can only be used once. If it expires, your consultant can send a new one.</p>",
          `<p>${escapeHtml(identity.tradingName)}</p>`,
        ].join("\n"),
        text: message,
        category: "selfie-link",
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

    // A token whose delivery did not positively succeed must not stay usable —
    // an unconfirmed live credential authorising a KYC capture is cancelled
    // even when the provider outcome is ambiguous; the consumer simply asks for
    // a fresh link. The audit below records the true provider verdict, never a
    // claim of proven non-delivery.
    if (!delivery.ok) {
      await prisma.selfieCaptureToken.updateMany({
        where: { id: minted.id, tenantId: tenant.id, usedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      })
    }

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: delivery.ok
        ? AuditAction.SELFIE_LINK_SENT
        : AuditAction.SELFIE_LINK_SEND_FAILED,
      entity: "LoanApplication",
      entityId: application.id,
      ipAddress: recordedCallerIp(req) ?? undefined,
      newValue: {
        selfieLinkSent: delivery.ok,
        tokenId: minted.id,
        channel,
        // Masked: the audit log must not become a directory of consumer contact
        // details, and the URL secret is never logged at all — an audit reader
        // must not be able to capture on the consumer's behalf.
        sentTo: maskDestination(sentTo),
        expiresAt: minted.expiresAt.toISOString(),
        simulated: delivery.simulated ?? false,
        ...(delivery.ok ? {} : {
          failure: delivery.error ?? "send_failed",
          possiblyDelivered: delivery.providerOutcome !== undefined
            && delivery.providerOutcome !== "DEFINITELY_REJECTED",
        }),
      },
    })

    if (!delivery.ok) {
      const possiblyDelivered = delivery.providerOutcome !== undefined
        && delivery.providerOutcome !== "DEFINITELY_REJECTED"
      return NextResponse.json({
        error: possiblyDelivered
          ? "The provider gave no delivery verdict, so the link was cancelled to be safe. Send a fresh link."
          : "The capture link could not be delivered; the link was cancelled. Check the contact details and try again.",
        deliveryError: delivery.error ?? "send_failed",
      }, { status: 502 })
    }
    return NextResponse.json({
      success: true,
      channel,
      sentTo: maskDestination(sentTo),
      expiresAt: minted.expiresAt,
      simulated: delivery.simulated ?? false,
    })
  })
}
