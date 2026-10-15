import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth-session"
import { prisma } from "@/lib/prisma"
import { generateTotpSecret, generateTotpUri, verifyTotpCode } from "@/lib/totp"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { isOperatorRole } from "@/lib/operator/roles"

// An operator user's own first TOTP enrolment: the one console API a session
// held at enrolment reaches (lib/proxy/operator-host.ts). Enrolling ends the
// session (tokenVersion), so the next sign-in verifies a code — the only kind
// of operator session the console accepts. Replacing or removing a secret is
// not offered here: an OPERATOR_ADMIN deactivates and re-invites instead.

async function operatorSession() {
  const user = (await getSession())?.user
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  if (!isOperatorRole(user.role) || typeof user.operatorId !== "string" || user.tenantId) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  return { user: { id: user.id, email: user.email, operatorId: user.operatorId } }
}

export async function GET() {
  const s = await operatorSession()
  if (s.error) return s.error
  const operator = await prisma.operator.findUnique({ where: { id: s.user.operatorId }, select: { name: true } })
  const secret = generateTotpSecret()
  return NextResponse.json({ secret, otpauth: generateTotpUri(s.user.email, secret, operator?.name ?? "CredaFlow operator") })
}

export async function POST(req: NextRequest) {
  const s = await operatorSession()
  if (s.error) return s.error
  const body = (await req.json().catch(() => null)) as { secret?: unknown; code?: unknown } | null
  const secret = body?.secret
  const code = body?.code
  if (typeof secret !== "string" || typeof code !== "string" || !secret || !code) {
    return NextResponse.json({ error: "secret and code are required" }, { status: 400 })
  }
  const counter = verifyTotpCode(code.trim(), secret)
  if (counter === null) return NextResponse.json({ error: "Invalid verification code" }, { status: 422 })

  const enrolled = await prisma.$transaction(async (tx) => {
    // Only an account with no secret yet; the code that proved it is spent.
    const { count } = await tx.user.updateMany({
      where: { id: s.user.id, operatorId: s.user.operatorId, active: true, totpEnabled: false, totpSecret: null },
      data: { totpSecret: secret, totpEnabled: true, lastTotpCounter: counter, tokenVersion: { increment: 1 } },
    })
    if (count !== 1) return false
    await logAuditStrict({
      userId: s.user.id, userEmail: s.user.email, action: AuditAction.TOTP_ENROLLED,
      entity: "User", entityId: s.user.id, oldValue: { totpEnabled: false },
      newValue: { totpEnabled: true, operatorId: s.user.operatorId }, ipAddress: callerIp(req),
    }, tx)
    return true
  })
  if (!enrolled) return NextResponse.json({ error: "Two-factor authentication is already on for this account" }, { status: 409 })
  return NextResponse.json({ ok: true, signInAgain: true })
}
