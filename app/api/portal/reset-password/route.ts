import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import bcrypt from "bcryptjs"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"
import { portalOffRefusal } from "@/lib/portal/portal-policy"
import { TRUSTED_CONTACT_WHERE } from "@/lib/clients/dealer-contact"
import { passwordPolicyError } from "@/lib/security/password-policy"
import { limiterAddress } from "@/lib/limiter-address"

// Per-EMAIL brute-force bound on the OTP (the load-bearing gate below).
const OTP_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 } as const

// Loose per-IP cap: bounds a single IP sweeping the endpoint across many
// victim emails, but generous so a shared CGNAT egress (the norm on SA mobile)
// can't lock out several legitimate clients mid-reset. The per-email gate is
// the tight bound.
const OTP_IP_CALL_CAP = { limit: 30, windowMs: 15 * 60 * 1000 } as const

export async function POST(req: NextRequest) {
  const ip = callerIp(req)
  const gate = await checkRateLimit(`reset-otp:${limiterAddress(ip)}`, OTP_IP_CALL_CAP)
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
    )
  }

  const body = await req.json() as {
    email?: string
    otp?: string
    password?: string
    confirmPassword?: string
  }
  const { email, otp, password, confirmPassword } = body

  if (!email || !otp || !password || !confirmPassword) {
    return NextResponse.json({ error: "All fields are required." }, { status: 400 })
  }

  const weak = passwordPolicyError(password)
  if (weak) {
    return NextResponse.json({ error: weak }, { status: 400 })
  }

  if (password !== confirmPassword) {
    return NextResponse.json({ error: "Passwords do not match." }, { status: 400 })
  }

  const normalised = email.toLowerCase().trim()

  // Per-EMAIL brute-force bound on the 6-digit OTP. The IP-only gate above is
  // bypassable with a botnet / rotating proxies; keying on the (invariant)
  // target email caps guesses to 5/15min per account regardless of source IP
  // (~5.7 years to exhaust the 10^6 code space). Load-bearing: this route is
  // directly callable without a prior forgot-password request, so it cannot
  // rely on the Turnstile gate that fronts the forgot endpoint.
  const acctGate = await checkRateLimit(`reset-otp:acct:${normalised}`, OTP_RATE_LIMIT, { newKeyAddress: limiterAddress(ip) })
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

    const otpRecord = await prisma.clientOtp.findFirst({
      where: {
        email: normalised,
        used: false,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    })

    if (!otpRecord || otpRecord.otp !== otp.trim()) {
      return NextResponse.json({ error: "Invalid or expired reset code." }, { status: 400 })
    }

    // Never a dealer-captured client whose contacts staff have not verified
    // (lib/clients/dealer-contact.ts; the database refuses its password too).
    const client = await prisma.client.findFirst({ where: { email: normalised, tenantId, ...TRUSTED_CONTACT_WHERE } })
    if (!client) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 })
    }

    const hashed = await bcrypt.hash(password, 12)

    const consumed = await prisma.$transaction(async (tx) => {
      // Claim the still-valid code once; a parallel reset cannot consume it again.
      const claimed = await tx.clientOtp.updateMany({
        where: { id: otpRecord.id, otp: otp.trim(), used: false, expiresAt: { gt: new Date() } },
        data: { used: true },
      })
      if (claimed.count !== 1) return false
      await tx.client.update({
        where: { id: client.id, tenantId },
        data: { portalPassword: hashed },
      })
      await logAuditStrict({
        tenantId,
        userEmail: normalised,
        action: AuditAction.CLIENT_UPDATED,
        entity: "Client",
        entityId: client.id,
        newValue: { passwordChanged: true, resetCodeConsumed: true, recoveryMethod: "portal_reset_code" },
        ipAddress: ip,
      }, tx)
      return true
    })
    if (!consumed) {
      return NextResponse.json({ error: "Invalid or expired reset code." }, { status: 400 })
    }

    return NextResponse.json({ success: true })
  })
}
