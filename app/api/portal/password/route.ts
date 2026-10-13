import { NextRequest, NextResponse } from "next/server"
import bcrypt from "bcryptjs"
import { prisma } from "@/lib/prisma"
import { auth } from "@/lib/auth"
import { checkRateLimit, callerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { keepClientSessionAfterPasswordChange } from "@/lib/client-session-cookie"

const PASSWORD_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 } as const

// Authenticated portal password change. Requires a valid CLIENT session and
// verification of the current password. Credentials are POSTed in the JSON body
// (never the query string) — the previous bare <form> did a GET, leaking
// passwords into the URL/history/logs.
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.email) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  // CLIENT sessions only. A staff session must never drive this endpoint
  // (defence in depth — the route also lives under /api/portal/*, which the
  // staff host 404s, but APP_MODE=all hosts do not).
  if ((session.user.role as string) !== "CLIENT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // Rate limit on BOTH the caller IP and the account. The per-account key bounds
  // brute-forcing the current password even when many clients share an egress
  // IP (e.g. behind the Docker/NGINX gateway, where per-IP collapses).
  const ip = callerIp(req)
  const ipGate = checkRateLimit(`portal-password-ip:${ip}`, PASSWORD_RATE_LIMIT)
  const acctGate = checkRateLimit(`portal-password-acct:${session.user.email.toLowerCase()}`, PASSWORD_RATE_LIMIT)
  if (!ipGate.allowed || !acctGate.allowed) {
    const retryAfter = Math.max(ipGate.retryAfterSeconds ?? 0, acctGate.retryAfterSeconds ?? 0)
    return NextResponse.json(
      { error: "Too many requests. Please try again later." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    )
  }

  let body: { currentPassword?: string; newPassword?: string; confirmPassword?: string }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const { currentPassword, newPassword, confirmPassword } = body

  if (!currentPassword || !newPassword || !confirmPassword) {
    return NextResponse.json({ error: "All fields are required." }, { status: 400 })
  }
  if (newPassword.length < 8) {
    return NextResponse.json({ error: "New password must be at least 8 characters." }, { status: 400 })
  }
  if (newPassword !== confirmPassword) {
    return NextResponse.json({ error: "New passwords do not match." }, { status: 400 })
  }
  if (newPassword === currentPassword) {
    return NextResponse.json({ error: "New password must be different from your current password." }, { status: 400 })
  }

  return withTenantContext(req, async (tenant) => {
    // By the session's own client id, not the email: the email is mutable and
    // not what the session was issued to.
    const client = await prisma.client.findFirst({
      where: { id: session.user.id, tenantId: tenant.id },
      select: { id: true, portalPassword: true },
    })

    if (!client || !client.portalPassword) {
      return NextResponse.json({ error: "Account not found." }, { status: 404 })
    }

    const ok = await bcrypt.compare(currentPassword, client.portalPassword)
    if (!ok) {
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 400 })
    }

    const hashed = await bcrypt.hash(newPassword, 12)
    // Compare-and-swap on the hash verified above. Hashing takes ~half a second,
    // and a password reset written in that window must win: it exists to end
    // every session, including this one. An unconditional update would
    // overwrite it and re-stamp this session.
    const written = await prisma.client.updateMany({
      where: { id: client.id, tenantId: tenant.id, portalPassword: client.portalPassword },
      data: { portalPassword: hashed },
    })
    if (written.count !== 1) {
      return NextResponse.json(
        { error: "Your password was changed while this was being saved, so nothing was updated. Please sign in again." },
        { status: 409 },
      )
    }

    // Audit the change — never log password values, only that it happened.
    await logAudit({
      tenantId: tenant.id,
      userEmail: session.user.email!,
      action: AuditAction.CLIENT_UPDATED,
      entity: "Client",
      entityId: client.id,
      newValue: { passwordChanged: true },
    })

    // The stored hash changed, which ends every session of this client that
    // still carries the old stamp. Re-issue this one so the change doesn't end it.
    const res = NextResponse.json({ success: true })
    await keepClientSessionAfterPasswordChange(req, res, client.id, tenant.id, hashed)
    return res
  })
}
