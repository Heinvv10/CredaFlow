import type { UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { checkRateLimit } from "@/lib/rate-limit"
import { signInTotpOutcome } from "@/lib/auth-totp-step"
import { enrolmentRequired, hasTotp, principalRefusal } from "@/lib/auth-principal"
import { checkStaffSignIn } from "@/lib/security/staff-access-enforcement"
import type { StaffAccessRefusal } from "@/lib/security/staff-access-messages"
import { AuditAction, logAudit } from "@/lib/audit"
import { getEnabledConnection } from "./connection"
import { claimTicket, readTicket } from "./tokens"

/**
 * The second half of an SSO sign-in: trade the ticket the callback minted for a
 * session (NextAuth's "sso" credentials provider, lib/auth.ts, calls this).
 * Everything that gates a password sign-in gates this one too, and the identity
 * provider can only ever add to it:
 *
 *  - the user must still pass principalRefusal (active, lender not suspended,
 *    a lender role) and the lender's working-hours / IP rules,
 *  - SECOND FACTOR. A user who enrolled CredaFlow TOTP always gives a code
 *    (so totpVerified, which gates identity and money writes, keeps meaning "a
 *    code was checked"). A user with none is held at enrolment when the lender
 *    requires 2FA, UNLESS the lender trusts its provider's MFA and the provider
 *    proved it for this sign-in. Provider MFA never produces totpVerified.
 *  - the ticket is spent only once the sign-in has succeeded, exactly once.
 */

const CODE_ATTEMPTS = { limit: 10, windowMs: 15 * 60 * 1000 } as const

export type SsoSignInUser = {
  id: string
  email: string
  name: string | null
  role: UserRole
  tenantId: string
  tokenVersion: number
  totpVerified: boolean
  totpEnrolmentRequired: boolean
  /** The session relies on the provider's MFA instead of a CredaFlow code (revalidatePrincipal re-checks the lender still trusts it). */
  idpMfa: boolean
}

export type SsoSignInResult =
  | { ok: true; user: SsoSignInUser }
  | { ok: false; error: "refused" | "totp_required" | "totp_invalid" | "rate_limited" }
  | { ok: false; error: "access_refused"; reason: StaffAccessRefusal }

export async function authorizeSso(input: {
  ticket: string
  code: unknown
  ip: string
  userAgent: string | null
  /** Records a FailedLoginAttempt row (lib/auth.ts). */
  recordFailure: (reason: string, email?: string) => Promise<unknown>
}): Promise<SsoSignInResult> {
  const refused = async (reason: string, email?: string): Promise<SsoSignInResult> => {
    await input.recordFailure(reason, email)
    return { ok: false, error: "refused" }
  }
  const ticket = await readTicket(input.ticket)
  if (!ticket) return refused("sso_ticket_invalid")

  const user = await prisma.user.findUnique({ where: { id: ticket.userId }, include: { tenant: { select: { status: true } } } })
  if (!user || user.tenantId !== ticket.tenantId) return refused("sso_user_missing")
  const conn = await runWithTenant(ticket.tenantId, () => getEnabledConnection(ticket.tenantId))
  if (!conn) return refused("sso_disabled", user.email)

  // A Super Admin signs in with password and CredaFlow TOTP (also the break-glass path), never through the provider.
  if (user.role === "SUPER_ADMIN") {
    await logAudit({
      tenantId: ticket.tenantId, userId: user.id, userEmail: user.email, action: AuditAction.SSO_SIGN_IN_REFUSED,
      entity: "User", entityId: user.id, newValue: { reason: "super_admin" }, ipAddress: input.ip === "unknown" ? undefined : input.ip,
    })
    return refused("sso_super_admin", user.email)
  }

  const refusal = principalRefusal(user, "staff")
  if (refusal) {
    await logAudit({
      tenantId: ticket.tenantId, userId: user.id, userEmail: user.email, action: AuditAction.SSO_SIGN_IN_REFUSED,
      entity: "User", entityId: user.id, newValue: { reason: refusal }, ipAddress: input.ip === "unknown" ? undefined : input.ip,
    })
    return refused(`sso_${refusal}`, user.email)
  }

  const enrolled = hasTotp(user)
  const reliesOnIdp = !enrolled && conn.trustIdpMfa && ticket.idpMfa
  let totpVerified = false
  if (enrolled) {
    const hasCode = typeof input.code === "string" && input.code.trim() !== ""
    if (hasCode && !checkRateLimit(`sso:code:${user.id}`, CODE_ATTEMPTS).allowed) {
      await input.recordFailure("rate_limited", user.email)
      return { ok: false, error: "rate_limited" }
    }
    const totp = await signInTotpOutcome(user, input.code)
    if (totp.kind === "required") return { ok: false, error: "totp_required" }
    if (totp.kind !== "verified") {
      await input.recordFailure(totp.kind === "replayed" ? "totp_replay" : totp.kind === "misconfigured" ? "totp_misconfigured" : "totp_invalid", user.email)
      return { ok: false, error: "totp_invalid" }
    }
    totpVerified = true
  }
  const held = !enrolled && !reliesOnIdp ? await enrolmentRequired(user, "staff") : false

  const access = await checkStaffSignIn({
    tenantId: ticket.tenantId, userId: user.id, email: user.email, role: user.role, ip: input.ip, userAgent: input.userAgent,
  })
  if (!access.allowed) return { ok: false, error: "access_refused", reason: access.reason }

  // Last: nothing above may leave the ticket spent.
  if (!(await claimTicket(ticket))) return refused("sso_ticket_replayed", user.email)

  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
    .catch((err: unknown) => { console.error("[sso] lastLoginAt update failed:", err) })
  await prisma.loginLog.create({ data: { tenantId: ticket.tenantId, userId: user.id, ip: input.ip, userAgent: input.userAgent, success: true } })
    .catch((err: unknown) => { console.error("[sso] loginLog insert failed:", err) })
  return {
    ok: true,
    user: {
      id: user.id, email: user.email, name: user.name, role: user.role, tenantId: ticket.tenantId, tokenVersion: user.tokenVersion,
      totpVerified, totpEnrolmentRequired: held, idpMfa: reliesOnIdp,
    },
  }
}
