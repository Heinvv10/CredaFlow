/**
 * Who may hold a staff or operator session — one set of rules, applied at
 * sign-in (lib/auth.ts authorize, lib/operator/sign-in.ts) and again on every
 * request (revalidatePrincipal, from the JWT callback). A rule added to one
 * path and not the other is how a session outlives the reason it was refused.
 *
 *  - principalRefusal: active; the binding that fits the audience (lender
 *    staff: a lender role, a tenant, no operator, the tenant not SUSPENDED;
 *    operator staff: an operator role, an operator, no tenant).
 *  - enrolmentRequired: a user with no TOTP is held at enrolment — always for
 *    operator staff, per the lender's policy for lender staff.
 *  - On each request the session's TOTP claims must still fit the row: a
 *    session that verified a code is refused once the user has no TOTP, and
 *    a held session once the user has enrolled (sign in again with a code).
 *
 * The audience on a request is the one the token was minted for; the row must
 * agree with it, so a token claiming operator fields for a lender user (or the
 * reverse) is refused, never re-routed to the other set of checks. The host
 * rule (OPERATOR_APP_HOST) is checked at sign-in and, per request, by
 * proxy.ts (lib/proxy/operator-host.ts): the JWT callback has no request.
 */
import { prisma } from "@/lib/prisma"
import { isOperatorRole } from "@/lib/operator/roles"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"

export type Audience = "staff" | "operator"

export type PrincipalRow = {
  active: boolean
  role: string
  tenantId: string | null
  operatorId?: string | null
  totpEnabled?: boolean
  totpSecret?: string | null
  tenant?: { status: string } | null
}

export type PrincipalRefusal =
  | "inactive" | "binding_conflict" | "not_operator" | "operator_unassigned"
  | "not_staff" | "tenant_unassigned" | "tenant_suspended"

export function audienceOf(role: unknown): Audience {
  return isOperatorRole(role) ? "operator" : "staff"
}

export function principalRefusal(row: PrincipalRow, audience: Audience): PrincipalRefusal | null {
  if (!row.active) return "inactive"
  if (row.tenantId && row.operatorId) return "binding_conflict"
  if (audience === "operator") {
    if (!isOperatorRole(row.role)) return "not_operator"
    if (!row.operatorId) return "operator_unassigned"
    if (row.tenantId) return "binding_conflict"
    return null
  }
  if (isOperatorRole(row.role) || row.operatorId) return "not_staff"
  if (!row.tenantId) return "tenant_unassigned"
  // A suspended lender's staff cannot sign in, and open sessions end.
  if (row.tenant?.status === "SUSPENDED") return "tenant_suspended"
  return null
}

export const hasTotp = (row: Pick<PrincipalRow, "totpEnabled" | "totpSecret">) => row.totpEnabled === true || !!row.totpSecret

/** Whether a user with no TOTP must enrol before anything else. */
export async function enrolmentRequired(row: PrincipalRow, audience: Audience): Promise<boolean> {
  if (hasTotp(row)) return false
  if (audience === "operator") return true
  return isStaffTotpRequired(row.tenantId as string)
}

const PRINCIPAL_SELECT = {
  active: true, role: true, tenantId: true, operatorId: true, tokenVersion: true,
  totpEnabled: true, totpSecret: true, tenant: { select: { status: true } },
} as const

export type SessionClaims = { audience: Audience; totpVerified: boolean; totpEnrolmentRequired: boolean }

export type FreshPrincipal = {
  role: string
  tenantId: string | null
  operatorId: string | null
  totpEnrolmentRequired: boolean
}

/**
 * The session's principal as the database has it now. null → sign out;
 * "error" → transient DB failure (the caller keeps an already-bound token).
 */
export async function revalidatePrincipal(
  userId: string,
  tokenVersion: number,
  claims: SessionClaims = { audience: "staff", totpVerified: false, totpEnrolmentRequired: false },
): Promise<FreshPrincipal | null | "error"> {
  let row: (PrincipalRow & { tokenVersion: number }) | null
  let held: boolean
  try {
    row = await prisma.user.findUnique({ where: { id: userId }, select: PRINCIPAL_SELECT })
    if (!row || principalRefusal(row, claims.audience) || row.tokenVersion !== tokenVersion) return null
    if (claims.totpVerified && !hasTotp(row)) return null
    if (claims.totpEnrolmentRequired && hasTotp(row)) return null
    held = await enrolmentRequired(row, claims.audience)
  } catch (err) {
    console.error("[auth] revalidatePrincipal DB error — retaining existing token:", err)
    return "error"
  }
  return {
    role: row.role,
    tenantId: row.tenantId,
    operatorId: row.operatorId ?? null,
    // As sign-in would decide it now: a lender that turned 2FA on holds its
    // unenrolled staff from their next request.
    totpEnrolmentRequired: held,
  }
}
