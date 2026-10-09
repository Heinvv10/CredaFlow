import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import bcrypt from "bcryptjs"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"

// Per-EMAIL brute-force bound on the OTP (the load-bearing gate below).
const OTP_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 } as const

// Loose per-IP cap: bounds a single IP sweeping the endpoint across many
// victim emails, but generous so a shared CGNAT egress (the norm on SA mobile)
// can't lock out several legitimate clients mid-reset. The per-email gate is
// the tight bound.
const OTP_IP_CALL_CAP = { limit: 30, windowMs: 15 * 60 * 1000 } as const

export async function POST(req: NextRequest) {
  const ip = callerIp(req)
  const gate = checkRateLimit(`reset-otp:${ip}`, OTP_IP_CALL_CAP)
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

  if (password.length < 8) {
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 })
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
  const acctGate = checkRateLimit(`reset-otp:acct:${normalised}`, OTP_RATE_LIMIT)
  if (!acctGate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(acctGate.retryAfterSeconds) } },
    )
  }

  return withTenantContext(req, async (tenant) => {
    const tenantId = tenant.id

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

    const client = await prisma.client.findFirst({ where: { email: normalised, tenantId } })
    if (!client) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 })
    }

    const hashed = await bcrypt.hash(password, 12)

    await Promise.all([
      prisma.client.update({
        where: { id: client.id },
        data: { portalPassword: hashed },
      }),
      prisma.clientOtp.update({
        where: { id: otpRecord.id },
        data: { used: true },
      }),
    ])

    return NextResponse.json({ success: true })
  })
}
