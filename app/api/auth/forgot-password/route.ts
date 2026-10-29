import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { passwordResetEmailHtml } from "@/lib/email"
import { sendEmail } from "@/lib/email/service"
import { getLenderBrandName } from "@/lib/config/identity"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import crypto from "crypto"
import { STAFF_RESET_LINK_MINUTES } from "@/lib/password-reset"
import { SSO_BOUND_SELECT, passwordBlockedBySso } from "@/lib/sso/password-policy"

const EXPIRY_MINUTES = STAFF_RESET_LINK_MINUTES

// Per-IP cap. Real users send at most one or two reset emails; anything
// beyond that is enumeration or spam.
const RESET_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 } as const

export async function POST(req: NextRequest) {
  const ip = callerIp(req)
  const gate = await checkRateLimit(`forgot:staff:${ip}`, RESET_RATE_LIMIT)
  if (!gate.allowed) {
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSeconds) } },
    )
  }

  const { email } = await req.json() as { email: string }

  if (!email) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 })
  }

  // Always return success to prevent email enumeration
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: { id: true, tenantId: true, name: true, email: true, active: true, ...SSO_BOUND_SELECT },
  })

  // An SSO-bound user (SSO on) has no password way in, so no reset is issued; the answer is the same either way.
  if (user && user.active && !passwordBlockedBySso(user)) {
    const token = crypto.randomBytes(32).toString("hex")
    const expiry = new Date(Date.now() + EXPIRY_MINUTES * 60 * 1000)

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { resetToken: token, resetTokenExp: expiry },
      })
      await logAuditStrict({
        tenantId: user.tenantId ?? undefined,
        action: AuditAction.USER_UPDATED,
        entity: "User",
        entityId: user.id,
        newValue: { passwordResetRequested: true },
        ipAddress: ip,
      }, tx)
    })

    const baseUrl = process.env.NEXTAUTH_URL ?? process.env.AUTH_URL ?? "http://localhost:3300"
    const resetUrl = `${baseUrl}/reset-password?token=${token}`

    if (!user.tenantId) {
      console.error("[forgot-password] Active staff user has no tenant email configuration", {
        userId: user.id,
      })
    } else {
      const brandName = await getLenderBrandName(user.tenantId)
      const result = await sendEmail({
        tenantId: user.tenantId,
        to: user.email,
        subject: `Reset your ${brandName} password`,
        html: passwordResetEmailHtml({
          brandName,
          name: user.name ?? user.email,
          resetUrl,
          expiryMinutes: EXPIRY_MINUTES,
        }),
        category: "staff-password-reset",
        referenceId: user.id,
      }).catch((err: unknown) => ({
        ok: false,
        error: err instanceof Error ? err.message : "Unknown email error",
      }))
      if (!result.ok) {
        console.error("[forgot-password] Email send failed:", result.error)
      }
    }
  }

  // Always 200 — don't leak whether email exists
  return NextResponse.json({ ok: true })
}
