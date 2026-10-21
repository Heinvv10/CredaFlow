import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sendEmail } from "@/lib/email/service"
import { sendMessage } from "@/lib/messaging/send"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"
import { verifyTurnstile } from "@/lib/turnstile"
import { isPortalForgotNewSendEnabled } from "@/lib/messaging/flags"
import { normaliseEmail } from "@/lib/contact/identity"
import { lookupRecipientContact } from "@/lib/contact/recipient"
import { generateOtp } from "@/lib/otp"
import { findLenderIdentity } from "@/lib/config/identity"
import { demoCodeReveal } from "@/lib/config/demo-mode"
import { escapeHtml } from "@/lib/utils"
import { portalOffRefusal } from "@/lib/portal/portal-policy"
import { TRUSTED_CONTACT_WHERE } from "@/lib/clients/dealer-contact"
import { isWhatsAppCloudConfigured } from "@/lib/signing-otp/deliver"
import { clientReachableOnWhatsApp, portalOtpChannelFrom, sendPortalOtpByWhatsApp } from "@/lib/portal/portal-otp-whatsapp"

// Per-EMAIL send cap: bounds OTP-email spam on a single account regardless of
// source IP (distributed / CGNAT), and is the invariant a brute-force campaign
// can't escape by rotating IPs.
const FORGOT_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 } as const

// Loose per-IP pre-gate applied BEFORE Turnstile — bounds how many Cloudflare
// siteverify calls one IP can force, without CGNAT-locking shared SA mobile
// egress. Anti-amplification only; the per-email gate is the tight bound.
const FORGOT_IP_CALL_CAP = { limit: 30, windowMs: 15 * 60 * 1000 } as const

export async function POST(req: NextRequest) {
  const ip = callerIp(req)

  const ipCallCap = checkRateLimit(`forgot:ip:${ip}`, FORGOT_IP_CALL_CAP)
  if (!ipCallCap.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(ipCallCap.retryAfterSeconds) } },
    )
  }

  const body = await req.json() as { email?: string; turnstileToken?: string; channel?: string }
  const { email, turnstileToken } = body
  const channel = portalOtpChannelFrom(body.channel)

  // Bot defence: block automated OTP-email spam / account-enumeration sweeps.
  // A missing token short-circuits with no outbound call.
  const turnstile = await verifyTurnstile(turnstileToken, ip)
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: "Verification failed. Please refresh the page and try again." },
      { status: 400 },
    )
  }

  if (!email) {
    return NextResponse.json({ error: "Email is required." }, { status: 400 })
  }

  const normalised = normaliseEmail(email)

  // Per-email gate — same generic 429 for existing + unknown emails, so it
  // never becomes an account-existence oracle (preserves the enumeration
  // protection the 200-always responses below provide).
  const acctGate = checkRateLimit(`forgot:acct:${normalised}`, FORGOT_RATE_LIMIT)
  if (!acctGate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(acctGate.retryAfterSeconds) } },
    )
  }

  return withTenantContext(req, async (tenant) => {
    const tenantId = tenant.id
    const portalOff = await portalOffRefusal(tenantId)
    if (portalOff) return portalOff
    // Read for every request, before the account lookup, like the identity.
    const whatsappLeg = channel === "WHATSAPP" && await isWhatsAppCloudConfigured(tenantId)

    // Resolved BEFORE the account lookup, for every request: if the lender
    // identity were read only once a client matched, an unconfigured identity
    // would fail exactly the requests for existing accounts — an
    // account-existence oracle. The new pipeline renders from its template
    // and does not need it. The flag is read once so the two cannot disagree.
    const newSend = isPortalForgotNewSendEnabled()
    const legacyIdentity = newSend ? null : await findLenderIdentity(tenantId)
    if (!newSend && !legacyIdentity) {
      return NextResponse.json(
        { error: "Password reset is temporarily unavailable. Please contact us." },
        { status: 503 },
      )
    }

    // A dealer-captured client's contact details are untrusted until staff
    // verify them (lib/clients/dealer-contact.ts): no code goes to them.
    const client = await prisma.client.findFirst({ where: { email: normalised, tenantId, ...TRUSTED_CONTACT_WHERE } })

    // Always return success to avoid leaking account existence
    if (!client) {
      return NextResponse.json({ success: true })
    }

    const otp = generateOtp()
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
    const otpRecord = await prisma.$transaction(async (tx) => {
      const record = await tx.clientOtp.create({ data: { email: normalised, otp, expiresAt } })
      await logAuditStrict({
        tenantId,
        action: AuditAction.CLIENT_UPDATED,
        entity: "Client",
        entityId: client.id,
        newValue: { passwordResetRequested: true },
        ipAddress: ip,
      }, tx)
      return record
    })

    if (whatsappLeg && clientReachableOnWhatsApp(client)) {
      // Detached: awaiting the provider round-trip would make a matched email
      // measurably slower than an unknown one (an account-existence oracle).
      // Failures are audited inside; the caller is told the same as always.
      void sendPortalOtpByWhatsApp({ tenantId, client, code: otp, purpose: "password_reset", otpRecordId: otpRecord.id })
        .catch((err: unknown) => { console.error("[portal-forgot] WhatsApp send failed:", err) })
      return NextResponse.json({ success: true, ...demoCodeReveal(otp, normalised) })
    }

    if (newSend || !legacyIdentity) {
      // New path: sendMessage() via the Phase 9 S2 pipeline.
      // The client's OWN Contact (lib/contact/recipient.ts): a code is never filed
      // under, or gated by the consent of, someone else's Contact.
      const recipient = await lookupRecipientContact(prisma, {
        tenantId,
        channel: "EMAIL",
        value: normalised,
        ownerClientId: client.id,
      })
      const contact = recipient.ok ? recipient.contact : null
      if (!contact) {
        // Data drift: Client exists but no Contact row. Preserves the
        // enumeration-protection behaviour by 200ing without surfacing the
        // gap to the caller. Observability: a warning log so the gap is
        // visible in error tracking + we can backfill the missing
        // ContactIdentity row out-of-band.
        console.warn("[portal-forgot] Client without Contact:", { clientId: client.id, tenantId })
        return NextResponse.json({ success: true, ...demoCodeReveal(otp, normalised) })
      }
      const template = await prisma.messageTemplate.findFirst({
        where: { tenantId, key: "portal_forgot_password_email", channel: "EMAIL" },
      })
      if (!template) {
        // Migration not applied yet (e.g. flag flipped before deploy).
        console.warn("[portal-forgot] MessageTemplate missing:", { tenantId })
        return NextResponse.json({ success: true, ...demoCodeReveal(otp, normalised) })
      }
      // Fire-and-forget: a transient sendMessage failure must NOT 500 the
      // route. The OTP row is already written; the user can re-request a
      // code on the second screen. The messaging-retry cron picks up TRANSIENT
      // failures + the SUPPRESSED_BY_CONSENT terminal state is logged in
      // the Message row for ops. Not awaited, so the provider round-trip does
      // not tell a matched email from an unknown one by response time.
      void sendMessage({
        contactId: contact.id,
        channel: "EMAIL",
        template,
        vars: { firstName: client.firstName, otp },
        toValue: normalised,
        category: "portal-otp",
        idempotencyKey: `portal-otp:${otpRecord.id}:EMAIL`,
      }).catch((err: unknown) => {
        console.error("[portal-forgot] sendMessage failed:", err)
      })
      return NextResponse.json({ success: true, ...demoCodeReveal(otp, normalised) })
    }

    // Legacy path: direct sendEmail() — kept until all tenants are
    // confirmed on the new send pipeline.
    const { tradingName } = legacyIdentity
    // Detached for the same timing reason as the legs above.
    void sendEmail({
      tenantId,
      to: normalised,
      toName: `${client.firstName} ${client.lastName}`,
      subject: `Your ${tradingName} Portal Password Reset Code`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f8f9fb;border-radius:8px;">
          <div style="text-align:center;margin-bottom:24px;">
            <p style="font-size:11px;font-weight:bold;letter-spacing:4px;text-transform:uppercase;color:#4F46E5;">${escapeHtml(tradingName)}</p>
            <p style="font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-top:4px;">CLIENT PORTAL</p>
          </div>
          <h2 style="color:#1B1D24;margin-bottom:8px;">Password Reset Request</h2>
          <p style="color:#555;margin-bottom:24px;">Hi ${client.firstName}, use the code below to reset your portal password. It expires in 15 minutes.</p>
          <div style="background:#1B1D24;border-radius:8px;padding:24px;text-align:center;margin-bottom:24px;">
            <p style="color:#4F46E5;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">Your reset code</p>
            <p style="color:#fff;font-size:36px;font-weight:bold;letter-spacing:8px;margin:0;">${otp}</p>
          </div>
          <p style="color:#888;font-size:12px;">If you did not request a password reset, you can safely ignore this email.</p>
        </div>
      `,
      text: `Your ${tradingName} portal password reset code is: ${otp}. It expires in 15 minutes.`,
      category: "portal-otp",
    }).catch((err: unknown) => {
      console.error("[portal-forgot] reset email failed:", err)
    })

    return NextResponse.json({ success: true, ...demoCodeReveal(otp, normalised) })
  })
}
