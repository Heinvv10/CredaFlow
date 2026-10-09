import { redirect } from "next/navigation"
import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import type { AppRole } from "@/lib/auth"
import type { UserRole } from "@prisma/client"

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
