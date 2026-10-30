import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAudit } from "@/lib/audit"
import { callerIp, checkRateLimit, recordedCallerIp } from "@/lib/rate-limit"
import { signingOtpCaller } from "@/lib/signing-otp/caller"
import { SIGNING_OTP_REFUSAL_MESSAGES, verifySigningOtp, type VerifyRefusal } from "@/lib/signing-otp/challenge"
import { limiterAddress } from "@/lib/limiter-address"

type RouteCtx = { params: Promise<{ id: string }> }

// Per-IP cap; each challenge separately allows SIGNING_OTP_MAX_ATTEMPTS tries.
const IP_LIMIT = { limit: 60, windowMs: 15 * 60 * 1000 } as const

const STATUS: Record<VerifyRefusal, number> = {
  not_found: 404,
  wrong_code: 400,
  expired: 410,
  locked: 429,
  already_used: 409,
  delivery_failed: 409,
}

/** Check the code for one challenge. Body: { code }. */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const resolved = await signingOtpCaller()
  if ("error" in resolved) return resolved.error
  const { caller } = resolved

  const gate = await checkRateLimit(`signing-otp:verify:ip:${limiterAddress(callerIp(req))}`, IP_LIMIT)
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
    )
  }

  const { id } = await params
  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { code?: unknown } | null
    if (typeof body?.code !== "string" || !body.code.trim()) {
      return NextResponse.json({ error: "Enter the 6-digit code." }, { status: 400 })
    }
    // A borrower verifies only their own codes; staff only branch codes
    // (those a staff witness requested). Either miss reads as not found.
    const challenge = await prisma.signingOtpChallenge.findFirst({
      where: {
        id,
        tenantId: tenant.id,
        ...(caller.kind === "client" ? { clientId: caller.clientId } : { requestedByUserId: { not: null } }),
      },
      select: { id: true, clientId: true, purpose: true, subjectId: true },
    })
    if (!challenge) {
      return NextResponse.json({ error: SIGNING_OTP_REFUSAL_MESSAGES.not_found }, { status: 404 })
    }

    const result = await verifySigningOtp(prisma, {
      tenantId: tenant.id,
      clientId: challenge.clientId,
      challengeId: challenge.id,
      code: body.code,
    })
    const ip = recordedCallerIp(req)
    await logAudit({
      tenantId: tenant.id,
      userId: caller.kind === "staff" ? caller.userId : undefined,
      userEmail: caller.email,
      action: result.ok ? AuditAction.SIGNING_OTP_VERIFIED : AuditAction.SIGNING_OTP_REJECTED,
      entity: challenge.purpose === "DOCUMENT" ? "ClientDocument" : "LoanApplication",
      entityId: challenge.subjectId,
      newValue: {
        challengeId: challenge.id,
        purpose: challenge.purpose,
        method: caller.method,
        ...(result.ok ? {} : { reason: result.reason, attemptsLeft: result.attemptsLeft ?? null }),
      },
      ipAddress: ip ?? undefined,
    })
    if (result.ok) return NextResponse.json({ verified: true, challengeId: challenge.id })
    return NextResponse.json(
      {
        error: SIGNING_OTP_REFUSAL_MESSAGES[result.reason],
        signingOtp: result.reason,
        ...(result.attemptsLeft !== undefined ? { attemptsLeft: result.attemptsLeft } : {}),
      },
      { status: STATUS[result.reason] },
    )
  })
}
