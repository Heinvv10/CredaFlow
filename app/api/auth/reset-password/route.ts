import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import bcrypt from "bcryptjs"
import { passwordPolicyError } from "@/lib/security/password-policy"

export async function POST(req: NextRequest) {
  const { token, password } = await req.json() as { token: string; password: string }

  if (!token || !password) {
    return NextResponse.json({ error: "Token and password are required" }, { status: 400 })
  }
  const weak = passwordPolicyError(password)
  if (weak) {
    return NextResponse.json({ error: weak }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { resetToken: token },
    select: { id: true, tenantId: true, email: true, resetTokenExp: true, active: true },
  })

  if (!user || !user.active) {
    return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 })
  }
  if (!user.resetTokenExp || user.resetTokenExp < new Date()) {
    return NextResponse.json({ error: "This reset link has expired. Please request a new one." }, { status: 400 })
  }

  const hashed = await bcrypt.hash(password, 12)

  // Bumping tokenVersion invalidates any existing JWT sessions for this user
  // — important because a password reset implies the old credentials may be
  // compromised.
  const consumed = await prisma.$transaction(async (tx) => {
    // Hashing can overlap another reset. Only the still-live token may commit.
    const written = await tx.user.updateMany({
      where: { id: user.id, resetToken: token, active: true, resetTokenExp: { gt: new Date() } },
      data: {
        password: hashed,
        resetToken: null,
        resetTokenExp: null,
        tokenVersion: { increment: 1 },
      },
    })
    if (written.count !== 1) return false
    await logAuditStrict({
      tenantId: user.tenantId ?? undefined,
      userId: user.id,
      userEmail: user.email,
      action: AuditAction.USER_UPDATED,
      entity: "User",
      entityId: user.id,
      newValue: { passwordChanged: true, resetTokenConsumed: true, recoveryMethod: "staff_reset_token" },
      ipAddress: callerIp(req),
    }, tx)
    return true
  })
  if (!consumed) {
    return NextResponse.json({ error: "Invalid or expired reset link" }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}

// Validate token (GET) — used to check before showing the form
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token")
  if (!token) return NextResponse.json({ valid: false })

  const user = await prisma.user.findUnique({
    where: { resetToken: token },
    select: { id: true, name: true, resetTokenExp: true, active: true },
  })

  if (!user || !user.active || !user.resetTokenExp || user.resetTokenExp < new Date()) {
    return NextResponse.json({ valid: false })
  }

  return NextResponse.json({ valid: true, name: user.name })
}
