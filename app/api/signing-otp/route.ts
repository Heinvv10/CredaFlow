import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import type { SigningOtpPurpose } from "@prisma/client"
import { withTenantContext } from "@/lib/tenant"
import { callerIp, checkRateLimit, recordedCallerIp } from "@/lib/rate-limit"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import { signingOtpCaller } from "@/lib/signing-otp/caller"
import { isSigningOtpRequired } from "@/lib/signing-otp/policy"
import { resolveSigningSubject, SIGNING_OTP_PURPOSES } from "@/lib/signing-otp/subject"
import { OTP_CHANNELS, type OtpChannel } from "@/lib/signing-otp/deliver"
import { requestSigningOtp } from "@/lib/signing-otp/request"
import { SIGNING_OTP_REFUSAL_MESSAGES } from "@/lib/signing-otp/challenge"

// Loose per-IP cap on top of the per-subject budget counted in the database.
const IP_LIMIT = { limit: 30, windowMs: 15 * 60 * 1000 } as const

/**
 * Request a one-time code to sign an agreement, a debit mandate or a document.
 * Body: { purpose, subjectId, documentSha256, channel }. documentSha256 is the
 * digest of the bytes on the signer's screen; a code is only issued for the
 * current bytes, and only signs those.
 */
export async function POST(req: NextRequest) {
  const resolved = await signingOtpCaller()
  if ("error" in resolved) return resolved.error
  const { caller } = resolved

  const gate = checkRateLimit(`signing-otp:request:ip:${callerIp(req)}`, IP_LIMIT)
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
    )
  }

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const purpose = body?.purpose as SigningOtpPurpose
    const channel = body?.channel as OtpChannel
    const subjectId = typeof body?.subjectId === "string" ? body.subjectId.trim() : ""
    if (!SIGNING_OTP_PURPOSES.includes(purpose) || !OTP_CHANNELS.includes(channel) || !subjectId) {
      return NextResponse.json(
        { error: "purpose, subjectId and channel (EMAIL or WHATSAPP) are required." },
        { status: 400 },
      )
    }
    if (!isSha256Digest(body?.documentSha256)) {
      return NextResponse.json({ error: "documentSha256 of the document shown is required." }, { status: 400 })
    }
    // The debit mandate and asset-finance deal documents are e-signed by the
    // signer in the portal only (a deal's branch path is wet ink, confirmed).
    if (caller.kind === "staff" && (purpose === "DEBIT_MANDATE" || purpose === "DEAL_DOCUMENT")) {
      return NextResponse.json({ error: "This document is signed in the customer portal." }, { status: 403 })
    }
    if (!(await isSigningOtpRequired(tenant.id, caller.method))) {
      return NextResponse.json({ error: "A signing code is not required for this signature." }, { status: 409 })
    }

    const resolvedSubject = await resolveSigningSubject(tenant.id, purpose, subjectId)
    if (!resolvedSubject.ok) {
      return NextResponse.json({ error: resolvedSubject.error }, { status: resolvedSubject.status })
    }
    const { subject } = resolvedSubject
    if (caller.kind === "client" && subject.clientId !== caller.clientId) {
      return NextResponse.json({ error: "Not found." }, { status: 404 })
    }
    if (body?.documentSha256 !== subject.documentSha256) {
      return NextResponse.json(
        { error: SIGNING_OTP_REFUSAL_MESSAGES.document_changed, signingOtp: "document_changed" },
        { status: 409 },
      )
    }

    const result = await requestSigningOtp({
      subject,
      channel,
      method: caller.method,
      ip: recordedCallerIp(req),
      actor: caller.kind === "staff" ? { userId: caller.userId, email: caller.email } : { email: caller.email },
    })
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        {
          status: result.status,
          ...(result.retryAfterSeconds ? { headers: { "Retry-After": String(result.retryAfterSeconds) } } : {}),
        },
      )
    }
    return NextResponse.json(result.challenge)
  })
}
