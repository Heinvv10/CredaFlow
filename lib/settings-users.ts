import { hasMinRole, ROLE_HIERARCHY, type UserRole } from "@/lib/permissions"

export type Branch = { id: string; name: string }

export type SettingsUser = {
  id: string
  name: string | null
  email: string
  role: string
  active: boolean
  phone?: string | null
  lastLoginAt?: string | null
  branchId?: string | null
  branch?: { id: string; name: string } | null
  createdAt: string
  /** Whether 2FA is enrolled (never the secret). */
  totpEnabled?: boolean
  _count?: { approvedLoans: number; assignedLoans: number; auditLogs: number }
}

export type SettingsUsersResponse = { users: SettingsUser[]; branches: Branch[] }

/**
 * Fetches GET /api/settings/users and validates the response before parsing.
 * Throws on a non-OK response (e.g. the BRANCH_MANAGER guard rejecting a
 * lower role) instead of letting callers destructure an error body as data.
 */
export async function loadUsers(): Promise<SettingsUsersResponse> {
  const res = await fetch("/api/settings/users")
  if (!res.ok) throw new Error("Failed to load users")
  return res.json() as Promise<SettingsUsersResponse>
}

/**
 * The roles a caller may assign: their own and those below it. The server
 * enforces this (staffUserWriteRefusal in lib/auth-guards.ts); the form only
 * stops offering what would be refused.
 */
export function assignableRoles<T extends { value: string }>(roles: T[], callerRole: string): T[] {
  return roles.filter(r => hasMinRole(callerRole as UserRole, r.value as UserRole))
}

/**
 * Whether the caller may write `targetRole`'s account: a user who ranks below
 * them, or their own row. The server refuses the rest (staffUserWriteRefusal in
 * lib/auth-guards.ts); the table only stops offering it.
 */
export function canWriteUser(callerRole: string, targetRole: string, isSelf: boolean): boolean {
  const caller = ROLE_HIERARCHY.indexOf(callerRole as UserRole)
  const target = ROLE_HIERARCHY.indexOf(targetRole as UserRole)
  if (caller < 0 || target < 0) return false
  return isSelf ? caller >= target : caller > target
}

/**
 * Whether the Reset 2FA button is offered (DELETE /api/settings/users/[id]/totp):
 * ADMIN or above, in a TOTP-verified session, for a lower-ranked user with 2FA
 * enrolled. Your own is turned off under Settings → Security, with a code.
 */
export function canResetTotp(args: {
  callerRole: string
  callerTotpVerified: boolean
  targetRole: string
  targetEnrolled: boolean | undefined
  isSelf: boolean
}): boolean {
  return (
    args.callerTotpVerified &&
    args.targetEnrolled === true &&
    hasMinRole(args.callerRole as UserRole, "ADMIN") &&
    canWriteUser(args.callerRole, args.targetRole, args.isSelf) &&
    !args.isSelf
  )
}

/** The confirm text; with the lender's setting off it cannot promise re-enrolment. */
export function resetTotpConfirm(name: string, staffTotpRequired: boolean): string {
  return staffTotpRequired
    ? `Reset two-factor authentication for ${name}? They will be signed out and must set it up again at their next sign-in.`
    : `Reset two-factor authentication for ${name}? They will be signed out. Two-factor authentication will be off until they set it up again.`
}
