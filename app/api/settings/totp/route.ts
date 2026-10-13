import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { claimTotpCounter } from "@/lib/totp-claim"
import { prisma } from "@/lib/prisma"
import { generateTotpSecret, generateTotpUri, verifyTotpCode } from "@/lib/totp"
import { withTenantContext } from "@/lib/tenant"
import { getLenderBrandName } from "@/lib/config/identity"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { callerIp, checkRateLimit } from "@/lib/rate-limit"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"

// A staff member's own two-factor enrolment. GET and POST are the only staff
// API a session held at enrolment can reach (lib/proxy/totp-enrolment.ts), so
// they take the session as it is rather than through requireApiRole.

// Guesses at the current code, whether to turn 2FA off or to replace the secret.
const CODE_ATTEMPTS = { limit: 5, windowMs: 15 * 60 * 1000 } as const
const withinAttempts = (userId: string) => checkRateLimit(`totp-current-code:${userId}`, CODE_ATTEMPTS).allowed
// A refused attempt at the two changes that must not be done by a stolen
// session is recorded: who tried, what, and why. Never the code or a secret.
const refuse = (
  staff: StaffSession, tenantId: string, operation: "disable" | "replace",
  reason: "wrong_code" | "replayed_code" | "policy_requires_totp", status: number, message: string,
) =>
  auditRefusal({
    action: AuditAction.TOTP_CHANGE_REFUSED, entity: "User", entityId: staff.id,
    userId: staff.id, userEmail: staff.email, tenantId, reason, status, detail: { operation },
  }).then(() => NextResponse.json({ error: message }, { status }))
const tooManyAttempts = () => NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 })

type StaffSession = { id: string; email: string; tenantId: string; enrolmentRequired: boolean }

async function staffSession(): Promise<{ staff: StaffSession; error?: never } | { staff?: never; error: NextResponse }> {
  const session = await auth()
  if (!session?.user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  const { id, email, tenantId, role, totpEnrolmentRequired } = session.user
  if (role === "CLIENT" || !tenantId) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  return { staff: { id, email, tenantId, enrolmentRequired: totpEnrolmentRequired === true } }
}

async function bodyOf(req: NextRequest): Promise<Record<string, unknown>> {
  const body: unknown = await req.json().catch(() => null)
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
}

// GET: generate a new TOTP secret for the current user
export async function GET(req: NextRequest) {
  const { staff, error } = await staffSession()
  if (error) return error

  return withTenantContext(req, async (tenant) => {
    const secret = generateTotpSecret()
    const otpauth = generateTotpUri(staff.email, secret, await getLenderBrandName(tenant.id))

    return NextResponse.json({ secret, otpauth })
  })
}

// POST: verify and enable TOTP. Replacing the secret of an enrolled account
// needs the current code (replay-protected, rate-limited with turning 2FA off)
// and signs the user out: whoever holds a session could otherwise rebind 2FA to
// a secret of their own. A session held at enrolment ends here too, so the next
// sign-in carries a code (and so can do what only a TOTP-verified session may).
export async function POST(req: NextRequest) {
  const { staff, error } = await staffSession()
  if (error) return error

  return withTenantContext(req, async (tenant) => {
    const { secret, code, currentCode } = await bodyOf(req)
    if (typeof secret !== "string" || typeof code !== "string" || !secret || !code) {
      return NextResponse.json({ error: "secret and code are required" }, { status: 400 })
    }

    if (verifyTotpCode(code, secret) === null) {
      return NextResponse.json({ error: "Invalid verification code" }, { status: 422 })
    }

    const user = await prisma.user.findFirst({
      where: { id: staff.id, tenantId: tenant.id },
      select: { totpEnabled: true, totpSecret: true },
    })
    if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const replacing = user.totpEnabled || user.totpSecret !== null
    if (replacing) {
      if (typeof currentCode !== "string" || !currentCode || !user.totpSecret) {
        return NextResponse.json({ error: "Two-factor authentication is already on for this account" }, { status: 409 })
      }
      if (!withinAttempts(staff.id)) return tooManyAttempts()
      const matched = verifyTotpCode(currentCode.trim(), user.totpSecret)
      if (matched === null) return refuse(staff, tenant.id, "replace", "wrong_code", 422, "Invalid verification code")
      if (!(await claimTotpCounter(staff.id, matched))) return refuse(staff, tenant.id, "replace", "replayed_code", 422, "Invalid verification code")
    }

    const enrolled = await prisma.$transaction(async (tx) => {
      // Compare-and-set on the state the checks above were made against.
      const { count } = await tx.user.updateMany({
        where: replacing
          ? { id: staff.id, tenantId: tenant.id, totpEnabled: true, totpSecret: user.totpSecret }
          : { id: staff.id, tenantId: tenant.id, totpEnabled: false, totpSecret: null },
        data: { totpSecret: secret, totpEnabled: true, lastTotpCounter: null, ...(replacing || staff.enrolmentRequired ? { tokenVersion: { increment: 1 } } : {}) },
      })
      if (count === 0) return false
      await logAuditStrict({
        tenantId: tenant.id,
        userId: staff.id,
        userEmail: staff.email,
        action: replacing ? AuditAction.TOTP_REPLACED : AuditAction.TOTP_ENROLLED,
        entity: "User",
        entityId: staff.id,
        oldValue: { totpEnabled: replacing },
        newValue: { totpEnabled: true },
        ipAddress: callerIp(req),
      }, tx)
      return true
    })
    if (!enrolled) {
      return NextResponse.json({ error: "Two-factor authentication is already on for this account" }, { status: 409 })
    }

    return NextResponse.json({ ok: true, signInAgain: replacing || staff.enrolmentRequired })
  })
}

// DELETE: turn off your own TOTP. Needs a current valid code (replay-protected
// like sign-in) and is audited. Refused outright while the lender requires
// 2FA; an admin resets another user's through
// app/api/settings/users/[id]/totp/route.ts.
export async function DELETE(req: NextRequest) {
  const { staff, error } = await staffSession()
  if (error) return error

  return withTenantContext(req, async (tenant) => {
    if (await isStaffTotpRequired(tenant.id)) {
      return refuse(staff, tenant.id, "disable", "policy_requires_totp", 403, "Your organisation requires two-factor authentication. It cannot be turned off.")
    }

    const { code } = await bodyOf(req)
    if (typeof code !== "string" || !code) {
      return NextResponse.json({ error: "code is required" }, { status: 400 })
    }

    if (!withinAttempts(staff.id)) return tooManyAttempts()

    const user = await prisma.user.findFirst({
      where: { id: staff.id, tenantId: tenant.id },
      select: { totpEnabled: true, totpSecret: true },
    })
    if (!user || (!user.totpEnabled && !user.totpSecret)) return NextResponse.json({ ok: true })

    const matched = user.totpSecret ? verifyTotpCode(code.trim(), user.totpSecret) : null
    if (matched === null) return refuse(staff, tenant.id, "disable", "wrong_code", 422, "Invalid verification code")
    if (!(await claimTotpCounter(staff.id, matched))) return refuse(staff, tenant.id, "disable", "replayed_code", 422, "Invalid verification code")

    await prisma.$transaction(async (tx) => {
      // The bump ends the sessions a code vouched for (totpVerified), this one included.
      await tx.user.update({ where: { id: staff.id }, data: { totpSecret: null, totpEnabled: false, tokenVersion: { increment: 1 } } })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: staff.id,
        userEmail: staff.email,
        action: AuditAction.TOTP_DISABLED,
        entity: "User",
        entityId: staff.id,
        oldValue: { totpEnabled: true },
        newValue: { totpEnabled: false },
        ipAddress: callerIp(req),
      }, tx)
    })

    return NextResponse.json({ ok: true })
  })
}
