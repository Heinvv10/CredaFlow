/**
 * Where the staff access policy (lib/security/staff-access-policy.ts) is
 * enforced:
 *
 *  - at sign-in, from lib/auth.ts authorize(), after the password and TOTP
 *    have been checked (so a refusal reveals nothing to someone without both);
 *  - on every node-side session read, from the lib/auth.ts jwt callback. That
 *    callback already re-reads the User row on each auth() call to enforce
 *    deactivation and tokenVersion revocation; the policy columns ride on the
 *    same query (revalidatePrincipal), so a restricted session costs no extra
 *    round trip. A refusal ends the session exactly like a revocation does
 *    (requireRole → /api/auth/expired → sign-in form).
 *
 * The proxy (lib/auth-edge) decodes the JWT without the database and is not a
 * policy point; every staff page, API route and server action reaches auth().
 *
 * Refusals are written to FailedLoginAttempt and LoginLog (sign-in) and to the
 * audit log with their reason. A live session re-checks on every request, so
 * its audit rows are rate-limited per user and reason.
 */
import { headers } from "next/headers"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit } from "@/lib/audit"
import { callerIpFromHeaders, checkRateLimit } from "@/lib/rate-limit"
import {
  evaluateStaffAccess,
  isRestricted,
  policyFromConfig,
  type StaffAccessDecision,
  type StaffAccessPolicyColumns,
} from "./staff-access-policy"

const SESSION_AUDIT_DEDUPE = { limit: 1, windowMs: 10 * 60 * 1000 } as const

type StaffPrincipal = { tenantId: string; userId: string; email: string | null; role: string }

async function auditDecision(
  principal: StaffPrincipal,
  decision: StaffAccessDecision,
  ip: string,
  stage: "sign_in" | "session",
): Promise<void> {
  const reason = decision.allowed ? decision.bypassed : decision.reason
  if (!reason) return
  const action = decision.allowed ? AuditAction.STAFF_ACCESS_BYPASSED : AuditAction.STAFF_ACCESS_REFUSED
  if (stage === "session") {
    const gate = await checkRateLimit(`staff-access-audit:${principal.userId}:${action}:${reason}`, SESSION_AUDIT_DEDUPE)
    if (!gate.allowed) return
  }
  await logAudit({
    tenantId: principal.tenantId,
    userId: principal.userId,
    userEmail: principal.email ?? undefined,
    action,
    entity: "User",
    entityId: principal.userId,
    newValue: { reason, stage, role: principal.role, ip },
    ipAddress: ip === "unknown" ? undefined : ip,
  })
}

export async function readStaffAccessColumns(tenantId: string): Promise<StaffAccessPolicyColumns | null> {
  return prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { staffAccessHours: true, staffIpAllowlist: true },
  })
}

/** Sign-in gate. Records a refusal everywhere a failed sign-in is recorded. */
export async function checkStaffSignIn(
  principal: StaffPrincipal & { ip: string; userAgent: string | null },
  now: Date = new Date(),
): Promise<StaffAccessDecision> {
  const policy = policyFromConfig(await readStaffAccessColumns(principal.tenantId))
  const decision = evaluateStaffAccess(policy, { role: principal.role, now, ip: principal.ip })
  await auditDecision(principal, decision, principal.ip, "sign_in")
  if (!decision.allowed) {
    const ip = principal.ip
    await Promise.all([
      prisma.loginLog
        .create({ data: { tenantId: principal.tenantId, userId: principal.userId, ip, userAgent: principal.userAgent, success: false } })
        .catch((err: unknown) => { console.error("[staff-access] loginLog insert failed:", err) }),
      prisma.failedLoginAttempt
        .create({ data: { email: principal.email ?? "", ip, userAgent: principal.userAgent, reason: `access_${decision.reason}` } })
        .catch((err: unknown) => { console.error("[staff-access] failedLoginAttempt insert failed:", err) }),
    ])
  }
  return decision
}

/** The caller's IP for a session read, by the same algorithm as callerIp(). */
async function sessionCallerIp(): Promise<string> {
  try {
    return callerIpFromHeaders(await headers())
  } catch {
    // No request scope (a script or a test calling auth()): no address is
    // known, which an allowlist treats as not allowed.
    return "unknown"
  }
}

/**
 * Session gate for the jwt callback. False ends the session. An unrestricted
 * tenant returns true without reading the request.
 */
export async function staffSessionAllowed(
  principal: StaffPrincipal,
  columns: StaffAccessPolicyColumns | null,
  now: Date = new Date(),
): Promise<boolean> {
  const policy = policyFromConfig(columns)
  if (!isRestricted(policy)) return true
  const ip = await sessionCallerIp()
  const decision = evaluateStaffAccess(policy, { role: principal.role, now, ip })
  await auditDecision(principal, decision, ip, "session")
  return decision.allowed
}
