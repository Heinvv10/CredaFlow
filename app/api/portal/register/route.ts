import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import bcrypt from "bcryptjs"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"
import { verifyTurnstile } from "@/lib/turnstile"
import { sendEmail } from "@/lib/email/service"
import { logAudit, AuditAction } from "@/lib/audit"
import { generateOtp } from "@/lib/otp"
import { getLenderIdentity } from "@/lib/config/identity"
import { demoCodeReveal } from "@/lib/config/demo-mode"
import { escapeHtml } from "@/lib/utils"
import { sendMessage, SendBlockedError } from "@/lib/messaging/send"
import { isPortalActivationNewSendEnabled } from "@/lib/messaging/flags"
import { resolveMessagingTarget } from "@/lib/messaging/route-delivery"

const REGISTER_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 } as const

// Loose per-IP cap applied BEFORE Turnstile, purely to bound how many
// Cloudflare siteverify calls a single IP can force — a token-bearing flood
// would otherwise trigger unbounded outbound verifications. Deliberately
// generous so shared CGNAT egress (the norm on SA mobile networks) isn't
// locked out by legitimate concurrent registrations. This is an
// ANTI-AMPLIFICATION bound, not enumeration protection: the per-identity gate
// below only throttles repeated hits on a SINGLE account.
const REGISTER_IP_CALL_CAP = { limit: 30, windowMs: 15 * 60 * 1000 } as const

// Generic, enumeration-safe responses (SIGN-02). Not-found, already-activated
// and invalid/expired-OTP all resolve to one of these two messages so a
// caller can never distinguish which case occurred.
const GENERIC_REQUEST_MESSAGE =
  "If those details match an application, we've emailed a 6-digit activation code. Enter it below to finish."
const GENERIC_INVALID_MESSAGE = "Invalid or expired code."

export async function POST(req: NextRequest) {
  const ip = callerIp(req)

  // Loose per-IP pre-gate: bounds Turnstile-verify (Cloudflare) calls per IP so
  // a token-bearing flood can't force unbounded outbound verifications, without
  // reintroducing the tight-IP CGNAT lockout the per-identity gate replaces.
  const ipCallCap = checkRateLimit(`register:ip:${ip}`, REGISTER_IP_CALL_CAP)
  if (!ipCallCap.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(ipCallCap.retryAfterSeconds) } },
    )
  }

  let body: {
    email?: string
    idNumber?: string
    otp?: string
    password?: string
    confirmPassword?: string
    turnstileToken?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 })
  }
  const { email, idNumber, otp, password, confirmPassword, turnstileToken } = body

  // Bot defence (SIGN-07). Missing tokens short-circuit with no network call;
  // token-bearing requests hit Cloudflare but are bounded per IP by the cap above.
  const turnstile = await verifyTurnstile(turnstileToken, ip)
  if (!turnstile.ok) {
    return NextResponse.json(
      { error: "Verification failed. Please refresh the page and try again." },
      { status: 400 },
    )
  }

  if (typeof email !== "string" || typeof idNumber !== "string" || !email || !idNumber) {
    return NextResponse.json({ error: "Email and ID number are required." }, { status: 400 })
  }

  const normalisedEmail = email.toLowerCase().trim()
  const trimmedId = idNumber.trim()

  // Per-identity rate gate keyed on EMAIL ONLY — deliberately NOT email+idNumber.
  // The idNumber is attacker-controlled and, in verify mode, the OTP is compared
  // BEFORE the idNumber is validated; keying on idNumber would let an attacker
  // vary it each request to land in a fresh bucket and escape the throttle. Email
  // is the invariant across a brute-force campaign, so it's the correct key. This
  // is the load-bearing bound on OTP-guessing (and OTP-email-spam) per account.
  const identityGate = checkRateLimit(
    `register:${normalisedEmail}`,
    REGISTER_RATE_LIMIT,
  )
  if (!identityGate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(identityGate.retryAfterSeconds) } },
    )
  }

  if (!otp) {
    return requestActivationCode(req, ip, normalisedEmail, trimmedId)
  }

  if (typeof otp !== "string" || typeof password !== "string" || typeof confirmPassword !== "string"
    || !password || !confirmPassword) {
    return NextResponse.json({ error: "All fields are required." }, { status: 400 })
  }

  // Min 8 + a max so bcrypt's silent 72-byte truncation can't surprise anyone.
  if (password.length < 8 || password.length > 200) {
    return NextResponse.json({ error: "Password must be between 8 and 200 characters." }, { status: 400 })
  }

  if (password !== confirmPassword) {
    return NextResponse.json({ error: "Passwords do not match." }, { status: 400 })
  }

  return verifyAndActivate(req, ip, normalisedEmail, trimmedId, otp, password)
}

// REQUEST-CODE mode: proves nothing yet — just emails an activation code to
// the address on file for an un-activated client matching email+ID. Always
// returns the same generic success regardless of whether a match was found,
// so the response carries no information about account existence (SIGN-02).
async function requestActivationCode(req: NextRequest, ip: string, email: string, idNumber: string) {
  return withTenantContext(req, async (tenant) => {
    const tenantId = tenant.id

    const client = await prisma.client.findFirst({
      where: { email, idNumber, tenantId, portalPassword: null },
    })

    if (client) {
      const code = generateOtp()
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000)
      const otpRecord = await prisma.clientOtp.create({ data: { email, otp: code, expiresAt } })

      if (isPortalActivationNewSendEnabled()) {
        // New path: sendMessage() via the Phase 9 S2 pipeline, so the
        // activation email shows on the client's comms timeline as proof of
        // sending. The template is flagged redactStoredBody, so the timeline
        // records that a code was sent without recording the code itself —
        // a staff-visible OTP is an account-takeover path.
        //
        // Fire-and-forget covers the WHOLE block, Contact and template lookups
        // included: any awaited work here happens only on the matched branch,
        // so awaiting it would make a match measurably slower than a no-match
        // (which returns immediately) and leak client existence through
        // response timing. Nothing below this point may be awaited before the
        // response.
        void (async () => {
          const target = await resolveMessagingTarget({
            tenantId,
            channel: "EMAIL",
            value: email,
            templateKey: "portal_activation_email",
          })
          if (!target.ok) {
            // Data drift or a flag flipped ahead of the migration. Warn so it
            // is visible in error tracking; the user can re-request a code.
            console.warn("[portal-register] activation send skipped:", {
              clientId: client.id, tenantId, reason: target.reason,
            })
            return
          }
          try {
            await sendMessage({
              contactId: target.contact.id,
              channel: "EMAIL",
              template: target.template,
              // renderTemplate does no escaping and firstName lands in the HTML
              // body, so it is escaped here.
              vars: { firstName: escapeHtml(client.firstName), otp: code },
              toValue: email,
              toName: `${client.firstName} ${client.lastName}`.trim(),
              category: "portal-otp",
              idempotencyKey: `portal-activation:${otpRecord.id}:EMAIL`,
            })
          } catch (err) {
            if (err instanceof SendBlockedError) {
              // Eligibility refused it — most likely a channel opt-out. The
              // consumer is told nothing (enumeration safety) and no code ever
              // arrives, so without a durable record this failure is invisible
              // to everyone including support. Safe to await: we are already
              // detached from the request path.
              await logAudit({
                tenantId,
                action: AuditAction.MESSAGE_SEND_BLOCKED_BY_ELIGIBILITY,
                entity: "Client",
                entityId: client.id,
                newValue: {
                  reason: err.reason,
                  templateKey: "portal_activation_email",
                  channel: "EMAIL",
                  consumerToldNothing: true,
                },
              })
              return
            }
            throw err
          }
        })().catch(async (err: unknown) => {
          // Nobody awaits this promise, so a console line is the whole record
          // unless we write one. The likely trigger is
          // assertRedactedSendIsRecoverable where UNSUB_TOKEN_SECRET is unset
          // (a walkthrough environment): the consumer
          // gets success:true, no code ever arrives, and without this row
          // there is nothing to find. Same treatment as the SendBlockedError
          // sibling above.
          console.error("[portal-register] activation sendMessage failed:", err)
          try {
            await logAudit({
              tenantId,
              action: AuditAction.MESSAGE_SEND_FAILED_UNDELIVERED,
              entity: "Client",
              entityId: client.id,
              newValue: {
                templateKey: "portal_activation_email",
                channel: "EMAIL",
                failure: err instanceof Error ? err.message : String(err),
                consumerToldNothing: true,
              },
            })
          } catch (auditErr) {
            console.error("[portal-register] failed to audit the failed activation send:", auditErr)
          }
        })

        return NextResponse.json({ success: true, message: GENERIC_REQUEST_MESSAGE, ...demoCodeReveal(code, email) })
      }

      // Legacy path: direct sendEmail(). Kept until the new path has soaked.
      //
      // Fire-and-forget: awaiting the email round-trip would make a matched
      // request measurably slower than a no-match (which returns immediately),
      // leaking client existence via response timing. The OTP row is already
      // written; a transient send failure just means the user re-requests.
      //
      // The identity read sits INSIDE the detached chain for the same reason: an
      // await here would add a DB round-trip to the matched path only. A missing
      // identity fails closed — no email — and is logged by the catch below.
      void getLenderIdentity(tenantId).then(({ tradingName }) => sendEmail({
        tenantId,
        to: email,
        toName: `${client.firstName} ${client.lastName}`,
        subject: `Activate Your ${tradingName} Portal Account`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;padding:32px;background:#f8f9fb;border-radius:8px;">
            <div style="text-align:center;margin-bottom:24px;">
              <p style="font-size:11px;font-weight:bold;letter-spacing:4px;text-transform:uppercase;color:#4F46E5;">${escapeHtml(tradingName)}</p>
              <p style="font-size:9px;letter-spacing:3px;text-transform:uppercase;color:#888;margin-top:4px;">CLIENT PORTAL</p>
            </div>
            <h2 style="color:#1B1D24;margin-bottom:8px;">Activate Your Portal Account</h2>
            <p style="color:#555;margin-bottom:24px;">Hi ${client.firstName}, use the code below to activate your portal account. It expires in 15 minutes.</p>
            <div style="background:#1B1D24;border-radius:8px;padding:24px;text-align:center;margin-bottom:24px;">
              <p style="color:#4F46E5;font-size:11px;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">Your activation code</p>
              <p style="color:#fff;font-size:36px;font-weight:bold;letter-spacing:8px;margin:0;">${code}</p>
            </div>
            <p style="color:#888;font-size:12px;">If you did not request to activate a portal account, you can safely ignore this email.</p>
          </div>
        `,
        text: `Your ${tradingName} portal activation code is: ${code}. It expires in 15 minutes.`,
        category: "portal-otp",
      })).catch((err: unknown) => {
        console.error("[portal-register] activation email failed:", err)
      })

      return NextResponse.json({ success: true, message: GENERIC_REQUEST_MESSAGE, ...demoCodeReveal(code, email) })
    }

    return NextResponse.json({ success: true, message: GENERIC_REQUEST_MESSAGE })
  })
}

// VERIFY-ACTIVATE mode: proves email ownership via the OTP just sent, then
// sets the portal password. Every failure path (bad/expired OTP, no matching
// client, client already activated) returns the SAME generic 400 — none of
// them may be distinguishable to the caller (SIGN-01/SIGN-02).
async function verifyAndActivate(
  req: NextRequest,
  ip: string,
  email: string,
  idNumber: string,
  otp: string,
  password: string,
) {
  return withTenantContext(req, async (tenant) => {
    const tenantId = tenant.id

    const otpRecord = await prisma.clientOtp.findFirst({
      where: { email, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    })

    if (!otpRecord || otpRecord.otp !== otp.trim()) {
      return NextResponse.json({ error: GENERIC_INVALID_MESSAGE }, { status: 400 })
    }

    const client = await prisma.client.findFirst({ where: { email, idNumber, tenantId } })

    if (!client || client.portalPassword) {
      return NextResponse.json({ error: GENERIC_INVALID_MESSAGE }, { status: 400 })
    }

    // Atomically claim the OTP as single-use — but only now that we know we're
    // activating (AFTER the client match), so a correct-OTP/wrong-idNumber
    // attempt can't burn the victim's code. updateMany + count===1 is the
    // codebase's status-transition-race idiom: two concurrent verifies can't
    // both win the claim, so the account can't be double-activated.
    const claimed = await prisma.clientOtp.updateMany({
      where: { id: otpRecord.id, used: false },
      data: { used: true },
    })
    if (claimed.count !== 1) {
      return NextResponse.json({ error: GENERIC_INVALID_MESSAGE }, { status: 400 })
    }

    const hashed = await bcrypt.hash(password, 12)

    await prisma.client.update({ where: { id: client.id }, data: { portalPassword: hashed } })

    // Audit the activation (SIGN-03). Reuses CLIENT_UPDATED — the same
    // action app/api/portal/password/route.ts logs for a portalPassword
    // change — rather than adding a new AuditAction, which would be a Prisma
    // enum change requiring a migration. Never log password values, only
    // that the account was activated.
    await logAudit({
      tenantId,
      userEmail: client.email,
      action: AuditAction.CLIENT_UPDATED,
      entity: "Client",
      entityId: client.id,
      newValue: {
        event: "portal_account_activated",
        detail: "Portal account activated via OTP",
      },
      ipAddress: ip,
    })

    return NextResponse.json({ success: true, message: "Account activated. Please log in." })
  })
}
