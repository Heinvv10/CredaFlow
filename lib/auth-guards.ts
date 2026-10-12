import { redirect } from "next/navigation"
import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import type { AppRole } from "@/lib/auth"
import type { UserRole } from "@prisma/client"
import { AuditAction, logAudit } from "@/lib/audit"

export type { AppRole }

export type StaffUser = {
  id: string
  email: string
  name: string | null
  role: UserRole
  tenantId: string
  /** This session's sign-in verified a TOTP code. */
  totpVerified?: boolean
}

/**
 * Redirect a request whose session the node side rejected to the stale-session
 * route handler (NOT straight to /login). This branch is only reachable when the
 * edge middleware passed the request through (it trusts the JWT signature) but
 * `auth()` here returned no session — i.e. a stale principal (tokenVersion bump
 * or deactivation). Server Components can't clear cookies, so going via
 * /api/auth/expired (a route handler that can) breaks the /login ⇄ /dashboard
 * redirect loop. See app/api/auth/expired/route.ts.
 */
export function redirectStaleSession(): never {
  redirect("/api/auth/expired")
}

export async function requireRole(allowedRoles: AppRole[]): Promise<StaffUser> {
  const session = await auth()
  if (!session?.user) {
    redirectStaleSession()
  }
  if (!session.user.tenantId) {
    redirectStaleSession()
  }

  if (!allowedRoles.includes(session.user.role)) {
    redirect("/")
  }

  return session.user as StaffUser
}

/**
 * Page-side equivalent of `requireApiRole`. Uses the same `hasMinRole`
 * hierarchy check, so page gates stay in sync with their backing API guards.
 * Prefer this over a literal `requireRole([...])` Set anywhere the API uses
 * `requireApiRole(X)` — otherwise the page silently disagrees with the API
 * about which roles can access the data (the BRANCH_MANAGER gap that hit
 * R-06 in /compliance/fsca-return came from exactly this mismatch).
 *
 * Use the literal `requireRole([...])` form only for genuinely non-hierarchical
 * gates (e.g. allowing a junior role alongside a senior one).
 *
 * Usage:
 *   const user = await requireMinRole("LOAN_ADMIN")
 */
export async function requireMinRole(minRole: UserRole): Promise<StaffUser> {
  const session = await auth()
  if (!session?.user) {
    redirectStaleSession()
  }
  if (!session.user.tenantId) {
    redirectStaleSession()
  }

  if (!hasMinRole(session.user.role, minRole)) {
    redirect("/")
  }

  return session.user as StaffUser
}

type ApiGuardResult =
  | { user: StaffUser; error?: never }
  | { user?: never; error: NextResponse }

/**
 * API-route equivalent of requireRole: returns 401/403 JSON instead of redirecting.
 * CLIENT callers always receive 403 — CLIENT is not in the role hierarchy.
 *
 * Usage:
 *   const guard = await requireApiRole("LOAN_ADMIN")
 *   if (guard.error) return guard.error
 *   const { user } = guard  // user.role is a real UserRole (never "CLIENT")
 */
export async function requireApiRole(minRole: UserRole): Promise<ApiGuardResult> {
  const session = await auth()
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }
  if (!session.user.tenantId) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  if (!hasMinRole(session.user.role, minRole)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  return { user: session.user as StaffUser }
}

// Role hierarchy — higher index = more permissions. CLIENT is not listed; it
// never passes a staff role gate (hasMinRole returns false for it).
const ROLE_HIERARCHY: UserRole[] = [
  "READONLY",
  "COLLECTIONS_OFFICER",
  "COLLECTIONS_AGENT",
  "INSURANCE_OFFICER",
  "CREDIT_OFFICER",
  "LOAN_ADMIN",
  "BRANCH_MANAGER",
  "ADMIN",
  "SUPER_ADMIN",
]

export function hasMinRole(userRole: AppRole, minRole: UserRole): boolean {
  if (userRole === "CLIENT") return false
  const userIdx = ROLE_HIERARCHY.indexOf(userRole)
  const minIdx = ROLE_HIERARCHY.indexOf(minRole)
  // Unknown role (not in hierarchy) → deny. Prevents privilege escalation if a
  // new enum value is added to the schema but not yet added to ROLE_HIERARCHY.
  if (userIdx < 0 || minIdx < 0) return false
  return userIdx >= minIdx
}

type StaffUserWrite = {
  /** The target's CURRENT role; null when the write creates the user. */
  targetRole: UserRole | null
  /** The role the write assigns, as received; undefined when it leaves the role alone. */
  assignedRole: unknown
}

type StaffUserWriteRefusal = {
  status: 400 | 403
  error: string
  /** Machine-readable cause, as in lib/audit-refusals.ts. */
  reason: "totp_required" | "target_outranks_caller" | "invalid_role" | "role_above_caller"
}

/**
 * The one rule for a request that creates, edits or removes a staff user.
 * Returns null when the write may proceed.
 *
 * - TOTP: this session's sign-in verified a code — the same claim, for the
 *   same reason, as PUT /api/settings/identity.
 * - Target ceiling: nobody edits a user whose current role outranks their own.
 *   Any field counts: a new password or email on a senior account takes it over.
 * - Assigned ceiling: nobody assigns a role above their own. A value that is
 *   not a role in ROLE_HIERARCHY is refused, never written.
 *
 * Both keys of `write` are required so a caller cannot skip a half by omission.
 */
export function staffUserWriteRefusal(
  caller: Pick<StaffUser, "role" | "totpVerified">,
  write: StaffUserWrite,
): StaffUserWriteRefusal | null {
  if (caller.totpVerified !== true) {
    return {
      status: 403,
      reason: "totp_required",
      error: "Sign in with two-factor authentication to manage users. Enable it under Settings → Security, then sign out and back in.",
    }
  }
  // A role ROLE_HIERARCHY does not rank is -1: as caller it clears nothing, and
  // as target it is refused outright (fail closed, as hasMinRole).
  const callerRank = ROLE_HIERARCHY.indexOf(caller.role)
  if (write.targetRole !== null) {
    const targetRank = ROLE_HIERARCHY.indexOf(write.targetRole)
    if (targetRank < 0 || targetRank > callerRank) {
      return { status: 403, reason: "target_outranks_caller", error: "You cannot modify a user whose role is above your own" }
    }
  }
  if (write.assignedRole !== undefined) {
    const assignedRank = ROLE_HIERARCHY.indexOf(write.assignedRole as UserRole)
    if (assignedRank < 0) return { status: 400, reason: "invalid_role", error: "Invalid role" }
    if (assignedRank > callerRank) {
      return { status: 403, reason: "role_above_caller", error: "You cannot assign a role above your own" }
    }
  }
  return null
}

/**
 * staffUserWriteRefusal as a route response. Every route that writes a staff
 * user calls this before its first write (and before any probe whose answer
 * would tell a refused caller something).
 *
 * A refusal by either ceiling is an escalation attempt, and is audited: the
 * trail must show who reached above their role, not only who was allowed to.
 */
export async function refuseStaffUserWrite(
  caller: StaffUser,
  write: StaffUserWrite & { tenantId: string; targetId?: string },
): Promise<NextResponse | null> {
  const refusal = staffUserWriteRefusal(caller, write)
  if (!refusal) return null
  if (refusal.reason === "target_outranks_caller" || refusal.reason === "role_above_caller") {
    await logAudit({
      tenantId: write.tenantId,
      userId: caller.id,
      userEmail: caller.email,
      action: AuditAction.USER_WRITE_REFUSED,
      entity: "User",
      entityId: write.targetId,
      newValue: {
        refused: true,
        reason: refusal.reason,
        httpStatus: refusal.status,
        callerRole: caller.role,
        targetRole: write.targetRole,
        // Only a role that passed validation: on a target refusal the body's
        // value was never checked and is not recorded.
        ...(refusal.reason === "role_above_caller" ? { assignedRole: write.assignedRole } : {}),
      },
    })
  }
  return NextResponse.json({ error: refusal.error }, { status: refusal.status })
}

// Permissions map: action → minimum required role
export const PERMISSIONS = {
  disburse_loan: "LOAN_ADMIN" as UserRole,
  approve_loan: "LOAN_ADMIN" as UserRole,
  decline_loan: "LOAN_ADMIN" as UserRole,
  delete_client: "ADMIN" as UserRole,
  manage_users: "BRANCH_MANAGER" as UserRole,
  view_reports: "READONLY" as UserRole,
  manage_settings: "ADMIN" as UserRole,
  view_audit_log: "LOAN_ADMIN" as UserRole,
  manage_branches: "ADMIN" as UserRole,
  // Mirrors lib/permissions.ts (the client-safe copy already had this key —
  // this file was missing it, so canDo(role, "record_payment") server-side
  // was previously unusable despite the docstring in permissions.ts claiming
  // to mirror this map).
  record_payment: "CREDIT_OFFICER" as UserRole,
} as const

export type PermissionKey = keyof typeof PERMISSIONS

export function canDo(userRole: AppRole, permission: PermissionKey): boolean {
  return hasMinRole(userRole, PERMISSIONS[permission])
}

type OwnerOrStaffResult =
  | { type: "staff"; user: StaffUser; error?: never }
  | { type: "client"; clientId: string; clientEmail: string | null; error?: never }
  | { type?: never; user?: never; clientId?: never; clientEmail?: never; error: NextResponse }

/**
 * For mixed-caller routes (portal client OR staff).
 * Call this AFTER fetching the resource so you have its clientId.
 * CLIENT sessions store the client DB id as session.user.id — no email lookup needed.
 */
export async function requireOwnerOrStaff(
  resourceClientId: string,
  minStaffRole: UserRole = "READONLY",
): Promise<OwnerOrStaffResult> {
  const session = await auth()
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }
  if (!session.user.tenantId) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }

  if (session.user.role === "CLIENT") {
    if (session.user.id !== resourceClientId) {
      return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
    }
    return {
      type: "client",
      clientId: session.user.id,
      clientEmail: session.user.email ?? null,
    }
  }

  if (!hasMinRole(session.user.role, minStaffRole)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  return { type: "staff", user: session.user as StaffUser }
}
