import { notFound, redirect } from "next/navigation"
import { NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import type { AppRole } from "@/lib/auth"
import { Prisma, type UserRole } from "@prisma/client"
import { PERMISSIONS as REGISTRY_PERMISSIONS } from "@/lib/registry/generated/permissions"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { recordSecurityEvent } from "@/lib/audit/security-events"
import type { prisma } from "@/lib/prisma"
import { ENROLMENT_PAGE, enrolmentRequiredResponse } from "@/lib/proxy/totp-enrolment"
import { NO_ACCESS_PAGE } from "@/lib/proxy/no-access"
import { refusesLoanBook } from "@/lib/security/loan-book-guard"
import { lacksLoanBook, NO_LOAN_BOOK_HOME } from "@/lib/security/loan-book-scope"
import { isOperatorRole } from "@/lib/operator/roles"
import { resolveOperatorTenantAccess } from "@/lib/operator/tenant-access"
import { REQUEST_ID_HEADER, REQUEST_METHOD_HEADER } from "@/lib/proxy/operator-read-only"

export type { AppRole }

export type StaffUser = {
  id: string
  email: string
  name: string | null
  role: UserRole
  tenantId: string
  /** This session's sign-in verified a TOTP code. */
  totpVerified?: boolean
  /** The lender requires 2FA and this user has none: the enrolment page only. */
  totpEnrolmentRequired?: boolean
  /** The User row's tokenVersion when this session was issued. */
  tokenVersion?: number
}

/**
 * Redirect a request whose session the node side rejected to the stale-session
 * route handler (NOT straight to /login). This branch is only reachable when the
 * edge middleware passed the request through (it trusts the JWT signature) but
 * `auth()` here returned no session — i.e. a stale principal (tokenVersion bump
 * or deactivation). Server Components can't clear cookies, so going via
 * /api/auth/expired (a route handler that can) breaks the /login ⇄ /dashboard
 * redirect loop. See app/api/auth/expired/route.ts.
 *
 * `callbackUrl` is where re-login should land; a `/portal` path sends the
 * user to the portal sign-in form instead of the staff one.
 */
export function redirectStaleSession(callbackUrl?: string): never {
  redirect(callbackUrl ? `/api/auth/expired?callbackUrl=${encodeURIComponent(callbackUrl)}` : "/api/auth/expired")
}

export { NO_ACCESS_PAGE }

export async function requireRole(allowedRoles: AppRole[]): Promise<StaffUser> {
  const session = await auth()
  if (!session?.user) {
    redirectStaleSession()
  }
  if (!session.user.tenantId) {
    redirectStaleSession()
  }

  if (session.user.totpEnrolmentRequired === true) {
    redirect(ENROLMENT_PAGE)
  }

  if (!allowedRoles.includes(session.user.role) || await refusesLoanBook(session.user.role)) {
    redirect(NO_ACCESS_PAGE)
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

  if (session.user.totpEnrolmentRequired === true) {
    redirect(ENROLMENT_PAGE)
  }

  if (!hasMinRole(session.user.role, minRole) || await refusesLoanBook(session.user.role)) {
    redirect(NO_ACCESS_PAGE)
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
  if (isOperatorRole(session.user.role)) {
    return operatorApiGuard(session.user, minRole)
  }
  if (!session.user.tenantId) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  if (session.user.totpEnrolmentRequired === true) {
    return { error: enrolmentRequiredResponse() }
  }
  if (!hasMinRole(session.user.role, minRole) || await refusesLoanBook(session.user.role)) {
    // Staff only: a portal client's id is not a User row, so it can neither be attributed nor sit on the audit FK.
    if (session.user.role !== "CLIENT") {
      await recordSecurityEvent({
        kind: "permission_denied", tenantId: session.user.tenantId, userId: session.user.id, email: session.user.email,
        reason: `requires ${minRole}`,
      })
    }
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  return { user: session.user as StaffUser }
}

/**
 * For a server action on loan-book data: requireMinRole, and view_loan_book
 * checked explicitly, not inferred from the page the action was posted from.
 */
export async function requireLoanBookStaff(minRole: UserRole): Promise<StaffUser> {
  const user = await requireMinRole(minRole)
  if (lacksLoanBook(user.role)) redirect(NO_ACCESS_PAGE)
  return user
}

/**
 * For a loan-book page segment's layout (lib/security/loan-book-scope.ts): a
 * role without view_loan_book goes to the no-access page, or from the
 * executive dashboard to its own home.
 */
export async function requireLoanBookPage(opts: { home?: boolean } = {}): Promise<void> {
  // The dashboard layout above already refuses a missing or stale session.
  const session = await auth()
  if (session?.user?.role === "DEALER") notFound()
  if (lacksLoanBook(session?.user?.role)) redirect(opts.home ? NO_LOAN_BOOK_HOME : NO_ACCESS_PAGE)
}

/**
 * An operator user (no tenant of their own) on a lender's API route: allowed
 * only through that lender's active support grant, as READONLY, audited
 * (lib/operator/tenant-access.ts). The lender is the request's tenant.
 */
async function operatorApiGuard(
  user: { id: string; email: string; totpVerified?: boolean },
  minRole: UserRole,
): Promise<ApiGuardResult> {
  const forbidden = { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  const { getResolvedTenantId } = await import("@/lib/tenant")
  let tenantId: string
  try {
    tenantId = await getResolvedTenantId()
  } catch (err) {
    // No resolvable lender for this request: nothing to grant access to.
    console.error("[auth-guards] operator request resolved no tenant — refusing:", err)
    return forbidden
  }
  // The method and request id as proxy.ts stamped them (a route handler
  // cannot see its own method from here); no stamp counts as a write.
  const { headers } = await import("next/headers")
  const h = await headers()
  const access = await resolveOperatorTenantAccess({
    session: user, tenantId, requiredRole: minRole, resource: `api:${minRole}`,
    method: h.get(REQUEST_METHOD_HEADER), requestId: h.get(REQUEST_ID_HEADER),
  })
  if (!access.allowed) return forbidden
  return { user: access.principal }
}

// Role hierarchy — higher index = more permissions. CLIENT is not listed; it
// never passes a staff role gate (hasMinRole returns false for it).
export const ROLE_HIERARCHY: UserRole[] = [
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
  if (userRole === "CLIENT" || userRole === "DEALER") return false
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
  /** The target is the caller's own row. Omitted means not: a peer is refused. */
  self?: boolean
  /** The write is a flag, not an account edit (the inbox roster): a peer is not refused. Never a senior. */
  allowPeer?: boolean
  /** The target is the lender's automated decisioning account (User.isSystem): it is managed by the system, never edited. */
  targetIsSystem?: boolean
}

type StaffUserWriteRefusal = {
  status: 400 | 403
  error: string
  /** Machine-readable cause, as in lib/audit-refusals.ts. */
  reason: "totp_required" | "target_outranks_caller" | "target_same_rank" | "invalid_role" | "role_above_caller" | "target_is_system"
}

/**
 * The one rule for a request that creates, edits or removes a staff user.
 * Returns null when the write may proceed.
 *
 * - TOTP: this session's sign-in verified a code — the same claim, for the
 *   same reason, as PUT /api/settings/identity.
 * - Target ceiling: nobody edits a user whose current role outranks their own,
 *   or equals it, their own row excepted (`self`). Any field counts: a new
 *   password or email on a senior or peer account takes it over.
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
  if (write.targetIsSystem === true) {
    return { status: 403, reason: "target_is_system", error: "The automated decisioning account is managed by the system and cannot be changed" }
  }
  // A role ROLE_HIERARCHY does not rank is -1: as caller it clears nothing, and
  // as target it is refused outright (fail closed, as hasMinRole).
  const callerRank = ROLE_HIERARCHY.indexOf(caller.role)
  if (write.targetRole !== null) {
    const targetRank = ROLE_HIERARCHY.indexOf(write.targetRole)
    if (targetRank < 0 || targetRank > callerRank) {
      return { status: 403, reason: "target_outranks_caller", error: "You cannot modify a user whose role is above your own" }
    }
    if (targetRank === callerRank && write.self !== true && write.allowPeer !== true) {
      return { status: 403, reason: "target_same_rank", error: "You cannot modify a user whose role is the same as your own" }
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
 * A refusal by any ceiling is an escalation attempt, and is audited: the
 * trail must show who reached above their role, not only who was allowed to.
 * The write is strict: if the row cannot be written this throws, so the
 * request fails (500) rather than refusing with no record. Either way nothing
 * is written to the user. Pass `db` to write the row in a transaction.
 */
export async function refuseStaffUserWrite(
  caller: StaffUser,
  write: StaffUserWrite & { tenantId: string; targetId?: string },
  db?: Pick<typeof prisma, "auditLog">,
): Promise<NextResponse | null> {
  const refusal = staffUserWriteRefusal(caller, { ...write, self: write.targetId !== undefined && write.targetId === caller.id })
  if (!refusal) return null
  if (refusal.reason === "target_outranks_caller" || refusal.reason === "target_same_rank" || refusal.reason === "role_above_caller") {
    await logAuditStrict({
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
    }, db)
  }
  return NextResponse.json({ error: refusal.error }, { status: refusal.status })
}

/**
 * refuseStaffUserWrite again, inside the write's own transaction, on the
 * caller's and the target's rows as they are now. Call it first in the
 * transaction, then write and audit through the same `tx`.
 *
 * The route's first check reads the target, then it probes and hashes before
 * writing: a promotion of the target or a demotion of the caller in that
 * window would otherwise carry the write onto an account the caller may no
 * longer touch. The rows stay locked until the write commits. FOR NO KEY
 * UPDATE is the lock an UPDATE of them takes, so a concurrent role change
 * waits; unlike FOR UPDATE it does not block an insert that only references
 * a row (an audit row naming the caller).
 *
 * A caller whose row is gone, inactive, in another tenant, or at a different
 * tokenVersion than the session (a role change, deactivation or password
 * reset since sign-in) is refused (403). Returns the locked roles for the
 * caller's own checks and audit.
 *
 * Sets a 2 s lock_timeout for the transaction: a row held elsewhere (an FK
 * insert's FOR KEY SHARE blocks an email change or a delete) must not keep the
 * caller's row locked, and their own sign-in waiting, until Prisma's 5 s
 * transaction timeout. Map the resulting error with staffUserWriteConflict.
 */
export async function refuseLockedStaffUserWrite(
  tx: Pick<typeof prisma, "$executeRaw" | "$queryRaw" | "auditLog">,
  caller: StaffUser,
  write: { tenantId: string; targetId?: string; assignedRole: unknown; allowPeer?: boolean },
): Promise<{ refused: NextResponse } | { refused: null; callerRole: UserRole; targetRole: UserRole | null }> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '2s'`
  const ids = write.targetId ? [caller.id, write.targetId] : [caller.id]
  const rows = await tx.$queryRaw<Array<{ id: string; role: UserRole; active: boolean; tokenVersion: number; isSystem: boolean }>>(Prisma.sql`
    SELECT "id", "role"::text AS "role", "active", "tokenVersion", "isSystem"
    FROM "User"
    WHERE "id" IN (${Prisma.join(ids)}) AND "tenantId" = ${write.tenantId}
    ORDER BY "id"
    FOR NO KEY UPDATE
  `)
  const fresh = rows.find(r => r.id === caller.id)
  if (!fresh?.active) return { refused: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  if (fresh.tokenVersion !== caller.tokenVersion) {
    return { refused: NextResponse.json({ error: "Your session is out of date. Sign in again." }, { status: 403 }) }
  }
  let targetRole: UserRole | null = null
  let targetIsSystem = false
  if (write.targetId) {
    const target = rows.find(r => r.id === write.targetId)
    if (!target) return { refused: NextResponse.json({ error: "User not found" }, { status: 404 }) }
    targetRole = target.role
    targetIsSystem = target.isSystem
  }
  const refused = await refuseStaffUserWrite(
    { ...caller, role: fresh.role },
    { tenantId: write.tenantId, targetId: write.targetId, targetRole, assignedRole: write.assignedRole, allowPeer: write.allowPeer, targetIsSystem },
    tx,
  )
  return refused ? { refused } : { refused: null, callerRole: fresh.role, targetRole }
}

/**
 * The 409 for a staff-user write transaction that could not get its locks in
 * time: the lock_timeout above (55P03 — Prisma raises it as an unknown error
 * from a model query, P2010 from a raw one), Prisma's own transaction timeout
 * (P2028), or a write conflict / deadlock (P2034). The transaction, and with it
 * the write and its audit row, has rolled back. Null for any other error.
 */
export function staffUserWriteConflict(err: unknown): NextResponse | null {
  const conflict =
    (err instanceof Prisma.PrismaClientKnownRequestError &&
      (err.code === "P2028" || err.code === "P2034" || (err.code === "P2010" && err.meta?.code === "55P03"))) ||
    (err instanceof Prisma.PrismaClientUnknownRequestError && err.message.includes('code: "55P03"'))
  return conflict ? NextResponse.json({ error: "This user is being changed elsewhere. Try again." }, { status: 409 }) : null
}

// Permissions map: action → minimum required role, or the explicit list of
// roles that hold it (lib/registry/define.ts). One file per domain under
// lib/registry/permissions/ (merged by scripts/gen-registries.ts;
// docs/ARCHITECTURE.md, "Registries").
export const PERMISSIONS = REGISTRY_PERMISSIONS

export type PermissionKey = keyof typeof PERMISSIONS

export function canDo(userRole: AppRole, permission: PermissionKey): boolean {
  const rule: UserRole | readonly UserRole[] = PERMISSIONS[permission]
  if (typeof rule !== "string") return userRole !== "CLIENT" && userRole !== "DEALER" && rule.includes(userRole)
  return hasMinRole(userRole, rule)
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

  if (session.user.totpEnrolmentRequired === true) {
    return { error: enrolmentRequiredResponse() }
  }
  if (!hasMinRole(session.user.role, minStaffRole) || await refusesLoanBook(session.user.role)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
  }
  return { type: "staff", user: session.user as StaffUser }
}
