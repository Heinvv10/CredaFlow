import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { sendEmail } from "@/lib/email/service"
import { sendMessage } from "@/lib/messaging/send"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"
import { verifyTurnstile } from "@/lib/turnstile"
import { isPortalForgotNewSendEnabled } from "@/lib/messaging/flags"
import { lookupContactByChannelValue, normaliseEmail } from "@/lib/contact/identity"
import { generateOtp } from "@/lib/otp"
import { findLenderIdentity } from "@/lib/config/identity"
import { escapeHtml } from "@/lib/utils"

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

  const body = await req.json() as { email?: string; turnstileToken?: string }
  const { email, turnstileToken } = body

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

    const client = await prisma.client.findFirst({ where: { email: normalised, tenantId } })

    // Always return success to avoid leaking account existence
    if (!client) {
      return NextResponse.json({ success: true })
    }

    const otp = generateOtp()
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
    const otpRecord = await prisma.clientOtp.create({ data: { email: normalised, otp, expiresAt } })

    if (newSend || !legacyIdentity) {
      // New path: sendMessage() via the Phase 9 S2 pipeline.
      const contact = await lookupContactByChannelValue(prisma, {
        tenantId,
        channel: "EMAIL",
        value: normalised,
      })
      if (!contact) {
        // Data drift: Client exists but no Contact row. Preserves the
        // enumeration-protection behaviour by 200ing without surfacing the
        // gap to the caller. Observability: a warning log so the gap is
        // visible in error tracking + we can backfill the missing
        // ContactIdentity row out-of-band.
        console.warn("[portal-forgot] Client without Contact:", { clientId: client.id, tenantId })
        return NextResponse.json({ success: true })
      }
      const template = await prisma.messageTemplate.findFirst({
        where: { tenantId, key: "portal_forgot_password_email", channel: "EMAIL" },
      })
      if (!template) {
        // Migration not applied yet (e.g. flag flipped before deploy).
        console.warn("[portal-forgot] MessageTemplate missing:", { tenantId })
        return NextResponse.json({ success: true })
      }
      // Fire-and-forget: a transient sendMessage failure must NOT 500 the
      // route. The OTP row is already written; the user can re-request a
      // code on the second screen. PR-2.5's retry cron picks up TRANSIENT
      // failures + the SUPPRESSED_BY_CONSENT terminal state is logged in
      // the Message row for ops.
      await sendMessage({
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
      return NextResponse.json({ success: true })
    }

    // Legacy path: direct sendEmail() — kept until all tenants are
    // confirmed on the new send pipeline.
    const { tradingName } = legacyIdentity
    await sendEmail({
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
    })

    return NextResponse.json({ success: true })
  })
}
