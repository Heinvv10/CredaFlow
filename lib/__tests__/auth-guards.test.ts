import { describe, it, expect, vi, beforeEach } from "vitest"

// Hoist mock functions so they're available inside vi.mock() factory closures.
const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }))

// Mock Next.js modules that next-auth pulls in at import time.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("next/server", () => ({ NextResponse: { json: vi.fn((body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 })) } }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/auth", () => ({ auth: mockAuth, AppRole: undefined }))
const { recordSecurityEvent } = vi.hoisted(() => ({ recordSecurityEvent: vi.fn(async () => undefined) }))
vi.mock("@/lib/audit/security-events", () => ({ recordSecurityEvent }))

import { hasMinRole, requireApiRole, requireOwnerOrStaff, canDo } from "../auth-guards"
import type { UserRole } from "@prisma/client"

// ---------------------------------------------------------------------------
// hasMinRole
// ---------------------------------------------------------------------------

describe("hasMinRole", () => {
  it("returns false for CLIENT regardless of minRole", () => {
    expect(hasMinRole("CLIENT", "READONLY")).toBe(false)
    expect(hasMinRole("CLIENT", "SUPER_ADMIN")).toBe(false)
  })

  it("returns true when userRole equals minRole", () => {
    expect(hasMinRole("LOAN_ADMIN", "LOAN_ADMIN")).toBe(true)
    expect(hasMinRole("READONLY", "READONLY")).toBe(true)
  })

  it("returns true when userRole is above minRole in hierarchy", () => {
    expect(hasMinRole("SUPER_ADMIN", "READONLY")).toBe(true)
    expect(hasMinRole("LOAN_ADMIN", "COLLECTIONS_OFFICER")).toBe(true)
    expect(hasMinRole("BRANCH_MANAGER", "CREDIT_OFFICER")).toBe(true)
  })

  it("returns false when userRole is below minRole", () => {
    expect(hasMinRole("READONLY", "CREDIT_OFFICER")).toBe(false)
    expect(hasMinRole("COLLECTIONS_OFFICER", "LOAN_ADMIN")).toBe(false)
    expect(hasMinRole("CREDIT_OFFICER", "BRANCH_MANAGER")).toBe(false)
  })

  it("COLLECTIONS_OFFICER clears READONLY but not CREDIT_OFFICER", () => {
    expect(hasMinRole("COLLECTIONS_OFFICER", "READONLY")).toBe(true)
    expect(hasMinRole("COLLECTIONS_OFFICER", "CREDIT_OFFICER")).toBe(false)
  })

  it("ADMIN is below SUPER_ADMIN", () => {
    expect(hasMinRole("ADMIN", "SUPER_ADMIN")).toBe(false)
    expect(hasMinRole("SUPER_ADMIN", "ADMIN")).toBe(true)
  })

  // Unknown role must never pass — prevents privilege escalation when a new
  // enum value is added to the schema but not yet added to ROLE_HIERARCHY.
  it("returns false for an unrecognised role (fail-closed)", () => {
    expect(hasMinRole("UNKNOWN_FUTURE_ROLE" as UserRole, "READONLY")).toBe(false)
    expect(hasMinRole("UNKNOWN_FUTURE_ROLE" as UserRole, "SUPER_ADMIN")).toBe(false)
  })

  const allRoles: UserRole[] = [
    "READONLY", "COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "INSURANCE_OFFICER",
    "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN",
  ]

  it("hierarchy is transitive: every role clears itself and all lower roles", () => {
    for (let i = 0; i < allRoles.length; i++) {
      for (let j = 0; j <= i; j++) {
        expect(hasMinRole(allRoles[i]!, allRoles[j]!)).toBe(true)
      }
    }
  })

  it("hierarchy is strict: no role clears a higher role", () => {
    for (let i = 0; i < allRoles.length; i++) {
      for (let j = i + 1; j < allRoles.length; j++) {
        expect(hasMinRole(allRoles[i]!, allRoles[j]!)).toBe(false)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// requireApiRole
// ---------------------------------------------------------------------------

describe("requireApiRole", () => {
  beforeEach(() => { mockAuth.mockReset() })

  it("returns 401 when there is no session", async () => {
    mockAuth.mockResolvedValue(null)
    const result = await requireApiRole("READONLY")
    expect(result.error).toBeDefined()
    expect(result.error?.status).toBe(401)
  })

  it("returns 403 when the user is CLIENT", async () => {
    mockAuth.mockResolvedValue({ user: { id: "c1", email: "x@x.com", name: null, role: "CLIENT", tenantId: "tenant-1" } })
    const result = await requireApiRole("READONLY")
    expect(result.error).toBeDefined()
    expect(result.error?.status).toBe(403)
  })

  it("returns 403 when the user is below the minimum role", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "a@a.com", name: null, role: "READONLY", tenantId: "tenant-1" } })
    const result = await requireApiRole("CREDIT_OFFICER")
    expect(result.error).toBeDefined()
    expect(result.error?.status).toBe(403)
  })

  it("returns the user when the role meets the minimum", async () => {
    const staff = { id: "u1", email: "a@a.com", name: "Alice", role: "LOAN_ADMIN", tenantId: "tenant-1" }
    mockAuth.mockResolvedValue({ user: staff })
    const result = await requireApiRole("CREDIT_OFFICER")
    expect(result.error).toBeUndefined()
    expect(result.user?.role).toBe("LOAN_ADMIN")
  })

  it("returns the user when the role exactly matches the minimum", async () => {
    const staff = { id: "u2", email: "b@b.com", name: "Bob", role: "READONLY", tenantId: "tenant-1" }
    mockAuth.mockResolvedValue({ user: staff })
    const result = await requireApiRole("READONLY")
    expect(result.error).toBeUndefined()
    expect(result.user?.role).toBe("READONLY")
  })

  it("records a refused staff permission as a security event on the user's lender", async () => {
    recordSecurityEvent.mockClear()
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "a@a.com", name: null, role: "READONLY", tenantId: "tenant-1" } })
    await requireApiRole("CREDIT_OFFICER")
    expect(recordSecurityEvent).toHaveBeenCalledTimes(1)
    expect(recordSecurityEvent).toHaveBeenCalledWith({ kind: "permission_denied", tenantId: "tenant-1", userId: "u1", email: "a@a.com", reason: "requires CREDIT_OFFICER" })
  })

  it("records nothing for a portal client, a missing session, or a permitted call", async () => {
    recordSecurityEvent.mockClear()
    mockAuth.mockResolvedValue({ user: { id: "c1", email: "x@x.com", name: null, role: "CLIENT", tenantId: "tenant-1" } })
    await requireApiRole("READONLY")
    mockAuth.mockResolvedValue(null)
    await requireApiRole("READONLY")
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "a@a.com", name: null, role: "LOAN_ADMIN", tenantId: "tenant-1" } })
    await requireApiRole("READONLY")
    expect(recordSecurityEvent).not.toHaveBeenCalled()
  })

  it("returns 403 for a staff principal without a persisted tenant", async () => {
    mockAuth.mockResolvedValue({
      user: {
        id: "u3",
        email: "unassigned@example.invalid",
        name: null,
        role: "LOAN_ADMIN",
        tenantId: null,
      },
    })
    const result = await requireApiRole("READONLY")
    expect(result.error?.status).toBe(403)
    expect(result.user).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// requireOwnerOrStaff
// ---------------------------------------------------------------------------

describe("requireOwnerOrStaff", () => {
  beforeEach(() => { mockAuth.mockReset() })

  it("returns 401 when there is no session", async () => {
    mockAuth.mockResolvedValue(null)
    const result = await requireOwnerOrStaff("client-123")
    expect(result.error).toBeDefined()
    expect(result.error?.status).toBe(401)
  })

  it("returns type:client when CLIENT session id matches resourceClientId", async () => {
    mockAuth.mockResolvedValue({ user: { id: "client-123", email: "c@c.com", name: null, role: "CLIENT", tenantId: "tenant-1" } })
    const result = await requireOwnerOrStaff("client-123")
    expect(result).toMatchObject({
      type: "client",
      clientId: "client-123",
      clientEmail: "c@c.com",
    })
  })

  it("returns 403 when CLIENT session id does not match resourceClientId (IDOR guard)", async () => {
    mockAuth.mockResolvedValue({ user: { id: "client-456", email: "d@d.com", name: null, role: "CLIENT", tenantId: "tenant-1" } })
    const result = await requireOwnerOrStaff("client-123")
    expect(result.error).toBeDefined()
    expect(result.error?.status).toBe(403)
  })

  it("returns type:staff when staff role meets minStaffRole", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u1", email: "e@e.com", name: "Eve", role: "LOAN_ADMIN", tenantId: "tenant-1" } })
    const result = await requireOwnerOrStaff("client-123", "READONLY")
    expect(result).toMatchObject({ type: "staff", user: { role: "LOAN_ADMIN" } })
  })

  it("returns 403 when staff role is below minStaffRole", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u2", email: "f@f.com", name: null, role: "READONLY", tenantId: "tenant-1" } })
    const result = await requireOwnerOrStaff("client-123", "CREDIT_OFFICER")
    expect(result.error).toBeDefined()
    expect(result.error?.status).toBe(403)
  })

  it("returns 403 for a tenantless client or staff principal", async () => {
    for (const role of ["CLIENT", "LOAN_ADMIN"] as const) {
      mockAuth.mockResolvedValue({
        user: {
          id: role === "CLIENT" ? "client-123" : "u3",
          email: "unassigned@example.invalid",
          name: null,
          role,
          tenantId: null,
        },
      })
      const result = await requireOwnerOrStaff("client-123")
      expect(result.error?.status).toBe(403)
    }
  })
})

// ---------------------------------------------------------------------------
// Fail-closed against a truthy-but-invalid auth object
//
// GHSA (Auth.js, fixed in next-auth 5.0.0-beta.32 / @auth/core 0.41.3):
// "Configuration errors can cause existence-based auth checks to fail open
// (auth object populated with an error)". The dangerous shape is NOT a null
// session — it is a *truthy* object that carries no usable principal, so a
// guard written as `if (!session)` admits the caller.
//
// The version bump is the fix; these tests are the ratchet. They assert the
// guards deny on every truthy-but-invalid shape, so a future refactor to a
// bare existence check (or a dependency regression that reintroduces the
// populated-error object) fails here instead of silently admitting callers.
// `mockResolvedValue(null)` above cannot catch that — null is the easy case.
// ---------------------------------------------------------------------------

describe("auth guards fail closed on a truthy-but-invalid session", () => {
  beforeEach(() => { mockAuth.mockReset() })

  // Shapes an errored/misconfigured auth() can return. Each is truthy.
  const invalidSessions: Array<[string, unknown]> = [
    ["empty object", {}],
    ["error-populated object", { error: "Configuration" }],
    ["error object with no user", { error: "Configuration", expires: "2026-01-01" }],
    ["explicitly undefined user", { user: undefined }],
    ["null user", { user: null }],
  ]

  for (const [label, session] of invalidSessions) {
    it(`requireApiRole returns 401 for a ${label}`, async () => {
      mockAuth.mockResolvedValue(session)
      const result = await requireApiRole("READONLY")
      expect(result.error?.status).toBe(401)
      expect(result.user).toBeUndefined()
    })

    it(`requireOwnerOrStaff returns 401 for a ${label}`, async () => {
      mockAuth.mockResolvedValue(session)
      const result = await requireOwnerOrStaff("client-123")
      expect(result.error?.status).toBe(401)
      // `type` is the discriminant: undefined proves neither a staff nor a
      // client principal was resolved.
      expect(result.type).toBeUndefined()
    })
  }

  // A user object that exists but carries no identity or tenant binding must
  // never resolve to a principal. This is the shape that would slip past a
  // guard checking only `session.user` truthiness.
  it("requireApiRole denies a user object with no id, role or tenant", async () => {
    mockAuth.mockResolvedValue({ user: {} })
    const result = await requireApiRole("READONLY")
    expect(result.error?.status).toBe(403)
    expect(result.user).toBeUndefined()
  })

  it("requireOwnerOrStaff denies a user object with no id, role or tenant", async () => {
    mockAuth.mockResolvedValue({ user: {} })
    const result = await requireOwnerOrStaff("client-123")
    expect(result.error?.status).toBe(403)
    expect(result.type).toBeUndefined()
  })

  // An unbound principal must not become an owner by id collision: a CLIENT
  // whose id matches the resource but which has no tenant is still denied.
  it("requireOwnerOrStaff denies a tenantless CLIENT whose id matches the resource", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "client-123", email: "c@c.com", name: null, role: "CLIENT", tenantId: undefined },
    })
    const result = await requireOwnerOrStaff("client-123")
    expect(result.error?.status).toBe(403)
    expect(result.type).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// canDo
// ---------------------------------------------------------------------------

describe("canDo", () => {
  it("READONLY can view_reports", () => {
    expect(canDo("READONLY", "view_reports")).toBe(true)
  })

  it("READONLY cannot disburse_loan", () => {
    expect(canDo("READONLY", "disburse_loan")).toBe(false)
  })

  it("LOAN_ADMIN can disburse_loan", () => {
    expect(canDo("LOAN_ADMIN", "disburse_loan")).toBe(true)
  })

  it("CREDIT_OFFICER cannot approve_loan (requires LOAN_ADMIN)", () => {
    expect(canDo("CREDIT_OFFICER", "approve_loan")).toBe(false)
  })

  it("CLIENT cannot do anything (not in staff hierarchy)", () => {
    expect(canDo("CLIENT", "view_reports")).toBe(false)
    expect(canDo("CLIENT", "disburse_loan")).toBe(false)
  })

  it("SUPER_ADMIN can do everything", () => {
    expect(canDo("SUPER_ADMIN", "disburse_loan")).toBe(true)
    expect(canDo("SUPER_ADMIN", "manage_settings")).toBe(true)
    expect(canDo("SUPER_ADMIN", "delete_client")).toBe(true)
  })

  it("manage_branches requires ADMIN — BRANCH_MANAGER is below the floor", () => {
    expect(canDo("BRANCH_MANAGER", "manage_branches")).toBe(false)
    expect(canDo("ADMIN", "manage_branches")).toBe(true)
    expect(canDo("SUPER_ADMIN", "manage_branches")).toBe(true)
  })
})
