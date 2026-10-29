import { AuditAction, logAudit } from "@/lib/audit"

/**
 * Per-lender "password sign-in is off" (SsoConnection.passwordLoginDisabled,
 * which the database allows only while SSO is enabled). The one exception is the
 * break-glass path: a SUPER_ADMIN who signs in with password AND a valid
 * CredaFlow TOTP code (what `lender:bootstrap-admin --break-glass` provisions),
 * so a lender whose identity provider is down is never locked out. Every such
 * sign-in is audited. Everyone else is refused.
 */

/** The `ssoConnection` select that rides on the sign-in's own user query (no extra round trip). */
export const PASSWORD_POLICY_SELECT = { select: { enabled: true, passwordLoginDisabled: true } } as const

export type PasswordPolicyRow = { tenant?: { ssoConnection?: { enabled: boolean; passwordLoginDisabled: boolean } | null } | null }

export function passwordLoginOff(user: PasswordPolicyRow): boolean {
  const sso = user.tenant?.ssoConnection
  return sso?.enabled === true && sso.passwordLoginDisabled
}

/**
 * An SSO-bound staff user (an SsoIdentity row) while the lender has SSO on signs in through the provider only: their
 * password, and a password reset, are not a way in. That stops a leftover or reset password from outliving the
 * provider's lifecycle (a person disabled there). A SUPER_ADMIN is exempt: password plus TOTP is their one path and
 * the break-glass one.
 */
export const SSO_BOUND_SELECT = {
  role: true,
  ssoIdentity: { select: { id: true } },
  tenant: { select: { ssoConnection: { select: { enabled: true } } } },
} as const

export type SsoBoundRow = {
  role: string
  ssoIdentity?: { id: string } | null
  tenant?: { ssoConnection?: { enabled: boolean } | null } | null
}

export function passwordBlockedBySso(user: SsoBoundRow): boolean {
  return user.role !== "SUPER_ADMIN" && !!user.ssoIdentity && user.tenant?.ssoConnection?.enabled === true
}

export async function auditBreakGlassSignIn(user: { id: string; email: string; tenantId: string }, ip: string): Promise<void> {
  await logAudit({
    tenantId: user.tenantId, userId: user.id, userEmail: user.email, action: AuditAction.SSO_PASSWORD_BREAK_GLASS,
    entity: "User", entityId: user.id, newValue: { method: "password+totp" }, ipAddress: ip === "unknown" ? undefined : ip,
  })
}
