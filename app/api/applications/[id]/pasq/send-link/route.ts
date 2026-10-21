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
import { readFile } from "@/lib/storage"
import { escapeHtml } from "@/lib/utils"
import { createHash } from "node:crypto"
import {
  maskDestination,
  mintPasqLinkToken,
  type PasqLinkChannel,
} from "@/lib/compliance/pasq-link-token.server"
import { isPasqLinkNewSendEnabled } from "@/lib/messaging/flags"
import { normaliseEmail, normalisePhone } from "@/lib/contact/identity"
import { deliverViaMessaging, resolveMessagingTarget } from "@/lib/messaging/route-delivery"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"

type RouteCtx = { params: Promise<{ id: string }> }

const E164 = /^\+[1-9]\d{7,14}$/
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function portalOrigin(): string {
  return (
    process.env.PORTAL_PUBLIC_ORIGIN
    ?? process.env.NEXT_PUBLIC_PORTAL_ORIGIN
    ?? requirePortalBaseUrl()
  ).replace(/\/+$/, "")
}

/**
 * Sends the consumer a one-time link to the quotation (NCA s.92(1)).
 *
 * Same role floor as PASQ generation: issuing the quotation and delivering it
 * are one act, split only because delivery can be retried.
 */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json().catch(() => null) as {
      channel?: unknown
    } | null
    const channel = body?.channel
    if (channel !== "SMS" && channel !== "WHATSAPP" && channel !== "EMAIL") {
      return NextResponse.json({ error: "channel must be 'SMS', 'WHATSAPP' or 'EMAIL'" }, { status: 400 })
    }
    // SMS channel off (BULKSMS_DRY_RUN). Refuse rather than dispatch a leg
    // that can only produce a SIMULATED record and an audit row reading as if
    // the consumer was sent the acknowledgement link.
    //
    // The only component that calls this route is PasqCeremonyPanel, which is
    // mounted NOWHERE today (dead code) and which now takes a required
    // `smsEnabled` prop so reviving it cannot ship an SMS button this route
    // refuses. Nothing here consults getChannelAvailability — that serves the
    // inbox composer, not the send-link surfaces. This 400 is the control.
    if (channel === "SMS" && !isSmsChannelEnabled()) {
      return NextResponse.json(
        { error: `${SMS_CHANNEL_OFF_REASON} — send the link over WhatsApp or email instead.` },
        { status: 400 },
      )
    }

    const application = await prisma.loanApplication.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        clientId: true,
        status: true,
        agreementGeneratedAt: true,
        pasqDocumentId: true,
        pasqDocumentSha256: true,
        pasqAcknowledgedAt: true,
        client: { select: { phone: true, whatsapp: true, email: true, firstName: true, lastName: true, createdByDealerId: true, dealerContactVerifiedAt: true } },
      },
    })
    if (!application) {
      return NextResponse.json({ error: "Application not found" }, { status: 404 })
    }
    // The PASQ is a consumer document (NCA s.92); an entity borrower has none.
    if (!hasClientBorrower(application)) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }
    if (application.status !== "APPROVED" || application.agreementGeneratedAt) {
      return NextResponse.json({
        error: "The acknowledgement link is only available during the signing ceremony, before the agreement is generated.",
      }, { status: 409 })
    }
    if (!application.pasqDocumentId || !application.pasqDocumentSha256) {
      return NextResponse.json({
        error: "Issue the quotation before sending the consumer an acknowledgement link.",
      }, { status: 409 })
    }
    if (application.pasqAcknowledgedAt) {
      return NextResponse.json({
        error: "The consumer has already acknowledged this quotation.",
      }, { status: 409 })
    }

    // Contact details a dealer typed may be the dealer's own: nothing goes to
    // them until a staff member verifies them (lib/clients/dealer-contact.ts).
    if (dealerContactUnverified(application.client)) {
      return NextResponse.json({ error: DEALER_CONTACT_UNVERIFIED }, { status: 409 })
    }

    // The destination is ALWAYS the number on the client record — never a
    // per-send override. This link produces consumer acknowledgement
    // evidence; letting staff redirect it to an arbitrary number would let a
    // single account manufacture that evidence by sending the link to
    // itself, exactly the channel this rebuild exists to eliminate. A wrong
    // number is fixed on the client record (its own audited workflow).
    const sentTo = channel === "EMAIL"
      ? application.client.email
      : channel === "WHATSAPP"
        ? application.client.whatsapp ?? application.client.phone
        : application.client.phone
    if (channel === "EMAIL") {
      if (!sentTo || !EMAIL_SHAPE.test(sentTo)) {
        return NextResponse.json({
          error: "The client record has no valid email address. Correct the client's contact details first — the acknowledgement link is only ever sent to the address on file.",
        }, { status: 422 })
      }
    } else if (!sentTo || !E164.test(sentTo)) {
      return NextResponse.json({
        error: "The client record has no valid E.164 number for this channel. Correct the client's contact details first — the acknowledgement link is only ever sent to the number on file.",
      }, { status: 422 })
    }

    // EMAIL carries the quotation PDF itself, so its bytes are resolved and
    // digest-checked BEFORE any token is minted: a tampered or missing
    // document is a hard, audited refusal — the same signal the agreement
    // delivery route treats as "investigate the document store" — never a
    // silently link-only email.
    let emailAttachment: { filename: string; content: Buffer; contentType: string } | null = null
    if (channel === "EMAIL") {
      const auditRefusal = async (failure: string, extra: Record<string, unknown> = {}) =>
        logAudit({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: AuditAction.PASQ_LINK_SEND_FAILED,
          entity: "LoanApplication",
          entityId: id,
          ipAddress: recordedCallerIp(req) ?? undefined,
          newValue: { channel, failure, sent: false, ...extra },
        })
      const pasqDocument = await prisma.clientDocument.findFirst({
        where: {
          id: application.pasqDocumentId,
          tenantId: tenant.id,
          clientId: application.clientId,
          docType: "FORM_20_PRE_AGREEMENT",
          deletedAt: null,
        },
        select: { id: true, fileName: true, storagePath: true },
      })
      if (!pasqDocument?.storagePath) {
        await auditRefusal("document_unavailable")
        return NextResponse.json({
          error: "The quotation document is unavailable. Re-issue the quotation before sending the link.",
        }, { status: 422 })
      }
      let bytes: Buffer
      try {
        bytes = await readFile(pasqDocument.storagePath)
      } catch {
        await auditRefusal("document_bytes_unavailable", { documentId: pasqDocument.id })
        return NextResponse.json({
          error: "The quotation bytes are unavailable. Re-issue the quotation before sending the link.",
        }, { status: 422 })
      }
      const digest = createHash("sha256").update(bytes).digest("hex")
      if (digest !== application.pasqDocumentSha256) {
        await auditRefusal("document_digest_mismatch", {
          documentId: pasqDocument.id,
          expectedSha256: application.pasqDocumentSha256,
          actualSha256: digest,
        })
        return NextResponse.json({
          error: "The stored quotation no longer matches its recorded digest. Do not deliver it — investigate the document store.",
        }, { status: 409 })
      }
      emailAttachment = {
        filename: pasqDocument.fileName || "pre-agreement-quotation.pdf",
        content: bytes,
        contentType: "application/pdf",
      }
    }

    // Invalidate-then-create must be one transaction, and the partial unique
    // index (one active token per application) makes the invariant a database
    // fact: a concurrent resend loses with a unique violation, never with two
    // live links.
    // Before minting, so an unconfigured identity leaves no orphaned link.
    const identity = await getLenderIdentity(tenant.id)
    let minted
    try {
      minted = await prisma.$transaction((tx) => mintPasqLinkToken(tx, {
        tenantId: tenant.id,
        applicationId: id,
        clientId: application.clientId,
        documentSha256: application.pasqDocumentSha256!,
        channel: channel as PasqLinkChannel,
        sentTo,
        createdById: guard.user.id,
      }))
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        return NextResponse.json({
          error: "Another acknowledgement link is being sent for this application. Wait a moment and check before resending.",
        }, { status: 409 })
      }
      throw error
    }

    const url = `${portalOrigin()}/pasq/${minted.secret}`
    const message =
      `${identity.tradingName}: your pre-agreement statement and quotation is ready. `
      + `Open and confirm it here: ${url} (link expires in 48 hours).`
    const clientName = [application.client.firstName, application.client.lastName]
      .filter(Boolean).join(" ")
    let delivery: { ok: boolean; simulated?: boolean; error?: string; providerOutcome?: string }
    // The WhatsApp leg deliberately stays on the legacy BulkSMS path. Routed
    // through sendMessage(), a tenant whose waProvider is WA_CLOUD (the
    // default is WA_UNOFFICIAL) resolves to WA_CLOUD, and an out-of-window
    // send there needs an APPROVED WABA template — which pasq_link_whatsapp
    // does not have. A new applicant who has never messaged in is always
    // out-of-window, i.e. the normal PASQ case, so cutting it over would fail
    // every send with WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE. It moves once Meta has
    // approved a template for it.
    const newSend = isPasqLinkNewSendEnabled() && channel !== "WHATSAPP"
    if (newSend) {
      // New path: the sendMessage() pipeline, so delivery of the
      // s.92(1) quotation link is provable from the client's comms timeline —
      // including the SMS leg, which previously wrote no Message at all.
      //
      // The templates are flagged redactStoredBody: the body carries a
      // single-use signing link, and persisting it would let anyone with
      // timeline access acknowledge the quotation on the consumer's behalf.
      const templateKey = channel === "EMAIL" ? "pasq_link_email" : "pasq_link_sms"
      const identityValue = channel === "EMAIL"
        ? normaliseEmail(sentTo!)
        : normalisePhone(sentTo!)
      const target = await resolveMessagingTarget({
        tenantId: tenant.id,
        channel,
        value: identityValue,
        templateKey,
        ownerClientId: application.clientId,
      })
      if (!target.ok) {
        // Data drift. Nothing left the system, so this is a definite
        // non-delivery — the token is invalidated below and the audit records
        // the reason, rather than the send disappearing silently.
        delivery = { ok: false, error: target.reason, providerOutcome: "DEFINITELY_REJECTED" }
      } else {
        delivery = await deliverViaMessaging({
          contactId: target.contact.id,
          channel,
          template: target.template,
          vars: {
            url,
            // renderTemplate does no escaping; the name is escaped here.
            greeting: clientName ? ` ${escapeHtml(clientName)}` : "",
          },
          // The SAME normalised value the Contact was resolved with — a raw
          // and a normalised form of one address must not disagree between
          // the identity lookup and the recorded destination.
          toValue: identityValue,
          toName: clientName || undefined,
          category: "pasq-link",
          applicationId: id,
          createdById: guard.user.id,
          attachments: emailAttachment ? [emailAttachment] : undefined,
          // A single-use signing link must never be replayed by the generic
          // retry cron — the consultant mints a fresh one instead.
          automaticRetry: false,
        })
      }
    } else if (channel === "EMAIL") {
      const emailResult = await sendEmail({
        tenantId: tenant.id,
        to: sentTo,
        toName: clientName || undefined,
        subject: "Your pre-agreement statement and quotation",
        html: [
          `<p>Good day${clientName ? ` ${escapeHtml(clientName)}` : ""},</p>`,
          `<p>Your pre-agreement statement and quotation from ${escapeHtml(identity.tradingName)} is ready. A copy is attached to this email for your records.</p>`,
          `<p>Please open the secure link below to review and confirm that you received it:</p>`,
          `<p><a href="${url}">${url}</a></p>`,
          "<p>The link expires in 48 hours and can only be used once. If it expires, your consultant can send a new one.</p>",
          `<p>${escapeHtml(identity.tradingName)}</p>`,
        ].join("\n"),
        text: message,
        category: "pasq-link",
        referenceId: id,
        attachments: emailAttachment ? [emailAttachment] : [],
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

    if (channel === "EMAIL" && (delivery.ok || delivery.providerOutcome !== "DEFINITELY_REJECTED")) {
      // POPIA: the quotation may have left the system by email. Logged as
      // the STAFF member's disclosure — never as a client 'view', which
      // would forge the consumer-received evidence the acknowledgement
      // depends on.
      await prisma.documentAccessLog.create({
        data: {
          documentId: application.pasqDocumentId!,
          accessorType: "staff",
          accessorId: guard.user.id,
          action: "email_to_client",
          ipAddress: recordedCallerIp(req),
          userAgent: req.headers.get("user-agent") ?? null,
        },
      })
    }

    // A token whose delivery did not positively succeed must not stay usable
    // — an unconfirmed live credential against the quotation is cancelled
    // even when the provider outcome is ambiguous; the consumer simply asks
    // for a fresh link. The audit below records the true provider verdict,
    // never a claim of proven non-delivery.
    if (!delivery.ok) {
      await prisma.pasqAcknowledgementToken.updateMany({
        where: { id: minted.id, tenantId: tenant.id, usedAt: null, invalidatedAt: null },
        data: { invalidatedAt: new Date() },
      })
    }

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: delivery.ok
        ? AuditAction.PASQ_LINK_SENT
        : AuditAction.PASQ_LINK_SEND_FAILED,
      entity: "LoanApplication",
      entityId: id,
      ipAddress: recordedCallerIp(req) ?? undefined,
      newValue: {
        tokenId: minted.id,
        channel,
        // The URL secret is never logged: an audit reader must not be able to
        // acknowledge on the consumer's behalf.
        sentTo: maskDestination(sentTo),
        documentSha256: application.pasqDocumentSha256,
        expiresAt: minted.expiresAt.toISOString(),
        simulated: delivery.simulated ?? false,
        ...(channel === "EMAIL" ? {
          // A derived fact, not a constant: if an optional-attachment path is
          // ever added, the audit must not keep claiming a PDF rode along.
          attachmentIncluded: emailAttachment !== null,
          providerOutcome: delivery.providerOutcome ?? null,
        } : {}),
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
          ? "The email provider gave no delivery verdict, so the link was cancelled to be safe. Send a fresh link."
          : "The acknowledgement link could not be delivered; the link was cancelled. Check the contact details and try again.",
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
