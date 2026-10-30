import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { callerIp, checkRateLimit } from "@/lib/rate-limit"
import { AuditAction, logAudit } from "@/lib/audit"
import { demoStaffWithoutTotp } from "@/lib/config/demo-mode"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { AuditPolicyError, policyView, saveAuditPolicy, siemTarget, type AuditPolicyInput } from "@/lib/audit/siem/policy"
import { sendTestEvent } from "@/lib/audit/siem/deliver"

// The lender's audit retention and SIEM forwarding (AuditPolicy). SUPER_ADMIN of the
// tenant only: it decides where the audit trail is sent. Changing it, and the test POST,
// need a session that verified TOTP where the lender requires staff 2FA. Secrets are
// write-only: a response says whether one is set, and shows the SIEM URL as its origin
// (a path or query may carry a key). The test POST sends a real event to the stored
// destination, so it is gated, limited and audited like a change. Retention is recorded
// policy; nothing deletes audit rows yet.
const TEST_LIMIT = { limit: 5, windowMs: 3_600_000 } as const

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    if (guard.user.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    return NextResponse.json(policyView(await prisma.auditPolicy.findUnique({ where: { tenantId: tenant.id } })))
  })
}

export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  return withTenantContext(req, async (tenant) => {
    if (actor.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const body = await req.json().catch(() => null) as AuditPolicyInput | null
    if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "A JSON object is required." }, { status: 400 })
    if (actor.totpVerified !== true && !demoStaffWithoutTotp() && await isStaffTotpRequired(tenant.id)) {
      return NextResponse.json({ error: "Sign in with two-factor authentication to change the audit policy." }, { status: 403 })
    }
    try {
      const policy = await saveAuditPolicy(tenant.id, { id: actor.id, email: actor.email }, body, { ipAddress: callerIp(req) })
      return NextResponse.json(policy)
    } catch (error) {
      if (error instanceof AuditPolicyError) return NextResponse.json({ error: error.message }, { status: 422 })
      throw error
    }
  })
}

/** Sends one synthetic event to the stored SIEM target. Answers a coarse error class only. */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error
  const actor = guard.user

  return withTenantContext(req, async (tenant) => {
    if (actor.tenantId !== tenant.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    if (actor.totpVerified !== true && !demoStaffWithoutTotp() && await isStaffTotpRequired(tenant.id)) {
      return NextResponse.json({ error: "Sign in with two-factor authentication to test the SIEM connection." }, { status: 403 })
    }
    if (!(await checkRateLimit(`audit-siem-test:${tenant.id}`, TEST_LIMIT)).allowed) {
      return NextResponse.json({ error: "Too many tests. Try again later." }, { status: 429 })
    }
    const policy = await prisma.auditPolicy.findUnique({ where: { tenantId: tenant.id } })
    if (!policy?.siemEnabled) return NextResponse.json({ error: "SIEM forwarding is not enabled." }, { status: 409 })
    const result = await sendTestEvent(siemTarget(policy), tenant.id)
    await logAudit({
      tenantId: tenant.id, userId: actor.id, userEmail: actor.email, action: AuditAction.AUDIT_SIEM_TEST_SENT, entity: "AuditPolicy",
      entityId: policy.id, newValue: { ok: result.ok, error: result.error }, ipAddress: callerIp(req),
    })
    return NextResponse.json({ ok: result.ok, error: result.error }, { status: result.ok ? 200 : 502 })
  })
}
