import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The session is the only auth seam mocked: the real requireApiRole and the
// real staff-user write gate (lib/auth-guards.ts) run against it.
const h = vi.hoisted(() => {
  const m = {
    auth: vi.fn(),
    userFindUnique: vi.fn(),
    userCreate: vi.fn(),
    branchFindFirst: vi.fn(),
    logAudit: vi.fn(),
    logAuditStrict: vi.fn(),
    /** The caller's row as the write's transaction locks it. */
    lockedRows: vi.fn(),
  }
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: (...args: unknown[]) => m.lockedRows(...args),
    user: { create: (args: unknown) => m.userCreate(args) },
    auditLog: { create: vi.fn() },
  }
  return { ...m, tx }
})

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: () => h.auth() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-a" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (args: unknown) => h.userFindUnique(args),
      // The create goes through the locked transaction's client.
      create: () => { throw new Error("user.create outside the transaction") },
    },
    branch: { findFirst: (args: unknown) => h.branchFindFirst(args) },
    $transaction: (fn: (tx: unknown) => unknown) => fn(h.tx),
  },
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAudit: (...args: unknown[]) => h.logAudit(...args),
  logAuditStrict: (...args: unknown[]) => h.logAuditStrict(...args),
}))
vi.mock("bcryptjs", () => ({ default: { hash: async (value: string) => `hashed:${value}` } }))

import { Prisma } from "@prisma/client"
import { POST } from "./route"

const URL = "https://app.example.test/api/settings/users"

function signedIn(role: string, extra: Record<string, unknown> = {}) {
  h.lockedRows.mockResolvedValue([{ id: "caller-1", role, active: true, tokenVersion: 2 }])
  h.auth.mockResolvedValue({
    user: { id: "caller-1", email: "caller@acme-lending.example", name: "Caller", role, tenantId: "tenant-a", totpVerified: true, tokenVersion: 2, ...extra },
  })
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "New Staff", email: "new.staff@acme-lending.example", password: "synthetic-pass-1", ...body }),
  }))
}

describe("POST /api/settings/users", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    h.userFindUnique.mockResolvedValue(null)
    h.userCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "new-1", ...data }))
  })

  it.each([
    ["BRANCH_MANAGER", "SUPER_ADMIN"],
    ["ADMIN", "SUPER_ADMIN"],
    ["BRANCH_MANAGER", "ADMIN"],
  ])("refuses a %s creating a %s, writes nothing and audits the attempt", async (callerRole, role) => {
    signedIn(callerRole)
    const res = await post({ role })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "You cannot assign a role above your own" })
    expect(h.userCreate).not.toHaveBeenCalled()
    // Refused before the email probe: no 409 oracle for an unauthorised caller.
    expect(h.userFindUnique).not.toHaveBeenCalled()
    expect(h.logAuditStrict).toHaveBeenCalledTimes(1)
    expect(h.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      userId: "caller-1",
      action: "USER_WRITE_REFUSED",
      entity: "User",
      newValue: expect.objectContaining({ refused: true, reason: "role_above_caller", callerRole, assignedRole: role }),
    }), undefined)
  })

  it.each([
    ["ADMIN", "LOAN_ADMIN"],
    ["SUPER_ADMIN", "SUPER_ADMIN"],
    ["ADMIN", "ADMIN"],
    ["BRANCH_MANAGER", "BRANCH_MANAGER"],
    ["BRANCH_MANAGER", "READONLY"],
  ])("lets a %s create a %s", async (callerRole, role) => {
    signedIn(callerRole)
    const res = await post({ role })

    expect(res.status).toBe(201)
    expect(h.userCreate).toHaveBeenCalledTimes(1)
    expect(h.userCreate.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-a", role, email: "new.staff@acme-lending.example", password: "hashed:synthetic-pass-1",
    })
    // In the transaction: the user never exists without its record.
    expect(h.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "USER_CREATED", userId: "caller-1", newValue: expect.objectContaining({ role }),
    }), h.tx)
    expect(h.logAudit).not.toHaveBeenCalled()
  })

  it.each(["OWNER", "CLIENT", "super_admin", 8, ["SUPER_ADMIN"]])("rejects a role that is not a staff role (%j) with 400 and writes nothing", async (role) => {
    signedIn("SUPER_ADMIN")
    const res = await post({ role })

    expect(res.status).toBe(400)
    expect(h.userCreate).not.toHaveBeenCalled()
  })

  // A password-only session (no code checked at sign-in) cannot create staff,
  // even one that enrolled TOTP after signing in.
  it.each([false, undefined])("refuses a session whose sign-in did not verify TOTP (%j), and writes nothing", async (totpVerified) => {
    signedIn("SUPER_ADMIN", { totpVerified })
    const res = await post({ role: "READONLY" })

    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/two-factor/)
    expect(h.userCreate).not.toHaveBeenCalled()
    expect(h.userFindUnique).not.toHaveBeenCalled()
  })

  // A body value is used as-is in Prisma queries, where an object is a filter
  // and a non-string is a 500. Every field is type-checked before any query.
  it.each([
    { email: { contains: "@" } },
    { email: ["new.staff@acme-lending.example"] },
    { name: { set: "x" } },
    { password: ["synthetic-pass-1"] },
    { password: { length: 12 } },
    { phone: 27820000000 },
    { branchId: { startsWith: "" } },
  ])("rejects a field of the wrong type (%j) with 400 and queries nothing", async (field) => {
    signedIn("ADMIN")
    const res = await post({ role: "CREDIT_OFFICER", ...field })

    expect(res.status).toBe(400)
    expect(h.userFindUnique).not.toHaveBeenCalled()
    expect(h.branchFindFirst).not.toHaveBeenCalled()
    expect(h.userCreate).not.toHaveBeenCalled()
  })

  it("creates nothing when the refused attempt cannot be audited", async () => {
    signedIn("ADMIN")
    h.logAuditStrict.mockRejectedValue(new Error("audit table unavailable"))

    await expect(post({ role: "SUPER_ADMIN" })).rejects.toThrow("audit table unavailable")
    expect(h.userCreate).not.toHaveBeenCalled()
  })

  // The first check uses the session's role; the create re-checks the
  // caller's row, locked, in its own transaction.
  it.each([
    ["demoted below the role being assigned", [{ id: "caller-1", role: "BRANCH_MANAGER", active: true, tokenVersion: 2 }]],
    ["deactivated", [{ id: "caller-1", role: "ADMIN", active: false, tokenVersion: 2 }]],
    ["signed out elsewhere (tokenVersion bumped)", [{ id: "caller-1", role: "ADMIN", active: true, tokenVersion: 3 }]],
    ["removed from the tenant", []],
  ])("refuses a caller %s after the first check, and creates nothing", async (_label, rows) => {
    signedIn("ADMIN")
    h.lockedRows.mockResolvedValue(rows)
    const res = await post({ role: "ADMIN" })

    expect(res.status).toBe(403)
    expect(h.userCreate).not.toHaveBeenCalled()
  })

  it("answers 409 when the create cannot take its lock in time, and audits nothing", async () => {
    signedIn("ADMIN")
    h.lockedRows.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("lock", { code: "P2034", clientVersion: "test" }))
    const res = await post({ role: "CREDIT_OFFICER" })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: "This user is being changed elsewhere. Try again." })
    expect(h.userCreate).not.toHaveBeenCalled()
    expect(h.logAuditStrict).not.toHaveBeenCalled()
  })

  it("refuses a caller below BRANCH_MANAGER", async () => {
    signedIn("LOAN_ADMIN")
    expect((await post({ role: "READONLY" })).status).toBe(403)
    expect(h.userCreate).not.toHaveBeenCalled()
  })

  // The new user's tenant is the caller's, whatever the body claims.
  it("creates the user in the caller's tenant, ignoring a tenantId in the body", async () => {
    signedIn("ADMIN")
    const res = await post({ role: "CREDIT_OFFICER", tenantId: "tenant-b", tenant: { connect: { id: "tenant-b" } } })

    expect(res.status).toBe(201)
    expect(h.userCreate.mock.calls[0][0].data).toEqual({
      tenantId: "tenant-a",
      name: "New Staff",
      email: "new.staff@acme-lending.example",
      role: "CREDIT_OFFICER",
      password: "hashed:synthetic-pass-1",
      phone: null,
      branchId: null,
    })
  })

  it("refuses a branch that is not in the caller's tenant, and writes nothing", async () => {
    signedIn("ADMIN")
    h.branchFindFirst.mockResolvedValue(null)
    const res = await post({ role: "CREDIT_OFFICER", branchId: "branch-of-tenant-b" })

    expect(res.status).toBe(404)
    expect(h.branchFindFirst).toHaveBeenCalledWith({ where: { id: "branch-of-tenant-b", tenantId: "tenant-a" }, select: { id: true } })
    expect(h.userCreate).not.toHaveBeenCalled()
  })
})
