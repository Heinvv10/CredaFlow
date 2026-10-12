import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The session is the only auth seam mocked: the real requireApiRole and the
// real staff-user write gate (lib/auth-guards.ts) run against it.
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  userUpdate: vi.fn(),
  userDelete: vi.fn(),
  auditLogCreate: vi.fn(),
  transaction: vi.fn(),
  branchFindFirst: vi.fn(),
  logAudit: vi.fn(),
  logAuditStrict: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: () => h.auth() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "tenant-a" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findFirst: (args: unknown) => h.userFindFirst(args),
      findUnique: (args: unknown) => h.userFindUnique(args),
      update: (args: unknown) => h.userUpdate(args),
      delete: (args: unknown) => h.userDelete(args),
    },
    auditLog: { create: (args: unknown) => h.auditLogCreate(args) },
    branch: { findFirst: (args: unknown) => h.branchFindFirst(args) },
    $transaction: (ops: unknown) => h.transaction(ops),
  },
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAudit: (...args: unknown[]) => h.logAudit(...args),
  logAuditStrict: (...args: unknown[]) => h.logAuditStrict(...args),
}))
vi.mock("bcryptjs", () => ({ default: { hash: async (value: string) => `hashed:${value}` } }))

import { DELETE, PATCH } from "./route"

const URL = "https://app.example.test/api/settings/users/target-1"

function signedIn(role: string, extra: Record<string, unknown> = {}) {
  h.auth.mockResolvedValue({
    user: { id: "caller-1", email: "caller@acme-lending.example", name: "Caller", role, tenantId: "tenant-a", totpVerified: true, ...extra },
  })
}

/** The stored row the tenant-scoped lookup returns for the target. */
function target(role: string, extra: Record<string, unknown> = {}) {
  h.userFindFirst.mockResolvedValue({
    id: "target-1", role, active: true, name: "Target Staff", email: "target@acme-lending.example",
    fitAndProper: null, _count: { auditLogs: 0, approvedLoans: 0 }, ...extra,
  })
}

function patch(body: Record<string, unknown>, id = "target-1") {
  return PATCH(
    new NextRequest(URL, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) },
  )
}

function del(id = "target-1") {
  return DELETE(new NextRequest(URL, { method: "DELETE" }), { params: Promise.resolve({ id }) })
}

const refusedAudit = (reason: string) => expect.objectContaining({
  tenantId: "tenant-a",
  userId: "caller-1",
  action: "USER_WRITE_REFUSED",
  entity: "User",
  entityId: "target-1",
  newValue: expect.objectContaining({ refused: true, reason }),
})

beforeEach(() => {
  vi.resetAllMocks()
  h.userFindUnique.mockResolvedValue(null)
  h.userUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "target-1", role: "CREDIT_OFFICER", ...data }))
})

describe("PATCH /api/settings/users/[id] — role ceiling", () => {
  it.each([
    ["BRANCH_MANAGER", "LOAN_ADMIN", "SUPER_ADMIN"],
    ["ADMIN", "LOAN_ADMIN", "SUPER_ADMIN"],
    ["BRANCH_MANAGER", "CREDIT_OFFICER", "ADMIN"],
  ])("refuses a %s promoting a %s to %s, writes nothing and audits the attempt", async (callerRole, currentRole, role) => {
    signedIn(callerRole)
    target(currentRole)
    const res = await patch({ role })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "You cannot assign a role above your own" })
    expect(h.userUpdate).not.toHaveBeenCalled()
    expect(h.logAuditStrict).toHaveBeenCalledTimes(1)
    expect(h.logAuditStrict).toHaveBeenCalledWith(refusedAudit("role_above_caller"))
  })

  it.each([
    ["BRANCH_MANAGER", "ADMIN", { password: "synthetic-pass-2" }],
    ["BRANCH_MANAGER", "ADMIN", { email: "takeover@acme-lending.example" }],
    ["BRANCH_MANAGER", "ADMIN", { active: false }],
    ["BRANCH_MANAGER", "ADMIN", { name: "Renamed" }],
    ["BRANCH_MANAGER", "ADMIN", { phone: "+27820000000" }],
    ["BRANCH_MANAGER", "ADMIN", { branchId: null }],
    ["BRANCH_MANAGER", "ADMIN", { role: "READONLY" }],
    ["BRANCH_MANAGER", "SUPER_ADMIN", { password: "synthetic-pass-2" }],
    ["ADMIN", "SUPER_ADMIN", { password: "synthetic-pass-2" }],
    ["ADMIN", "SUPER_ADMIN", { email: "takeover@acme-lending.example" }],
    ["ADMIN", "SUPER_ADMIN", { active: false }],
  ])("refuses a %s editing a %s (%j), writes nothing and audits the attempt", async (callerRole, currentRole, body) => {
    signedIn(callerRole)
    target(currentRole)
    const res = await patch(body)

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "You cannot modify a user whose role is above your own" })
    expect(h.userUpdate).not.toHaveBeenCalled()
    expect(h.logAuditStrict).toHaveBeenCalledTimes(1)
    expect(h.logAuditStrict).toHaveBeenCalledWith(refusedAudit("target_outranks_caller"))
  })

  it("writes nothing when the refused attempt cannot be audited", async () => {
    signedIn("BRANCH_MANAGER")
    target("ADMIN")
    h.logAuditStrict.mockRejectedValue(new Error("audit table unavailable"))

    await expect(patch({ password: "synthetic-pass-2" })).rejects.toThrow("audit table unavailable")
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  // Refused BEFORE the email-uniqueness probe, so the 409 cannot tell an
  // unauthorised caller whether an address is registered.
  it("refuses a senior user's email change without probing whether the address is taken", async () => {
    signedIn("BRANCH_MANAGER")
    target("ADMIN")
    h.userFindUnique.mockResolvedValue({ id: "someone-else" })
    const res = await patch({ email: "taken@acme-lending.example" })

    expect(res.status).toBe(403)
    expect(h.userFindUnique).not.toHaveBeenCalled()
  })

  it("refuses self-promotion and writes nothing", async () => {
    signedIn("ADMIN")
    target("ADMIN", { id: "caller-1" })
    const res = await patch({ role: "SUPER_ADMIN" }, "caller-1")

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "You cannot change your own role" })
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it("still refuses deactivating your own account", async () => {
    signedIn("ADMIN")
    target("ADMIN", { id: "caller-1" })
    expect((await patch({ active: false }, "caller-1")).status).toBe(400)
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it.each(["OWNER", "CLIENT", null, 8])("rejects a role that is not a staff role (%j) with 400 and writes nothing", async (role) => {
    signedIn("SUPER_ADMIN")
    target("CREDIT_OFFICER")
    const res = await patch({ role })

    expect(res.status).toBe(400)
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  // A body value is used as-is in Prisma queries, where an object is a filter
  // and a non-string is a 500. Every field is type-checked before any query.
  it.each([
    { email: { contains: "@" } },
    { email: 7 },
    { name: { set: "x" } },
    { password: ["synthetic-pass-2"] },
    { password: { length: 12 } },
    { phone: 27820000000 },
    { branchId: { startsWith: "" } },
    { active: "false" },
    { active: 0 },
  ])("rejects a field of the wrong type (%j) with 400 and queries nothing", async (field) => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    const res = await patch(field)

    expect(res.status).toBe(400)
    expect(h.userFindFirst).not.toHaveBeenCalled()
    expect(h.userFindUnique).not.toHaveBeenCalled()
    expect(h.branchFindFirst).not.toHaveBeenCalled()
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  // The forms send these shapes; they stay accepted.
  it("accepts null phone, branch and name", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    const res = await patch({ name: null, phone: null, branchId: null })

    expect(res.status).toBe(200)
    expect(h.userUpdate.mock.calls[0][0].data).toEqual({ name: null, phone: null, branchId: null })
  })

  it.each([false, undefined])("refuses a session whose sign-in did not verify TOTP (%j), and writes nothing", async (totpVerified) => {
    signedIn("SUPER_ADMIN", { totpVerified })
    target("CREDIT_OFFICER")
    const res = await patch({ password: "synthetic-pass-2" })

    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/two-factor/)
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  // The target is looked up inside the caller's tenant: another tenant's user
  // id resolves to nothing, whatever the body carries.
  it("answers 404 for a user outside the caller's tenant and writes nothing", async () => {
    signedIn("SUPER_ADMIN")
    h.userFindFirst.mockResolvedValue(null)
    const res = await patch({ role: "READONLY", tenantId: "tenant-b" }, "user-of-tenant-b")

    expect(res.status).toBe(404)
    expect(h.userFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "user-of-tenant-b", tenantId: "tenant-a" } }))
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it("never writes a tenantId from the body", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    const res = await patch({ name: "Renamed", tenantId: "tenant-b" })

    expect(res.status).toBe(200)
    expect(h.userUpdate.mock.calls[0][0].data).toEqual({ name: "Renamed" })
  })
})

describe("PATCH /api/settings/users/[id] — allowed writes and their audit row", () => {
  it.each([
    ["ADMIN", "CREDIT_OFFICER", "LOAN_ADMIN"],
    ["ADMIN", "CREDIT_OFFICER", "ADMIN"],
    ["BRANCH_MANAGER", "READONLY", "BRANCH_MANAGER"],
    ["SUPER_ADMIN", "ADMIN", "SUPER_ADMIN"],
    ["SUPER_ADMIN", "SUPER_ADMIN", "ADMIN"],
  ])("lets a %s change a %s to %s and audits the old and new role", async (callerRole, currentRole, role) => {
    signedIn(callerRole)
    target(currentRole)
    const res = await patch({ role })

    expect(res.status).toBe(200)
    expect(h.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "target-1" },
      data: { role, tokenVersion: { increment: 1 } },
    }))
    expect(h.logAudit).toHaveBeenCalledTimes(1)
    expect(h.logAudit).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      action: "USER_UPDATED",
      entity: "User",
      entityId: "target-1",
      userId: "caller-1",
      oldValue: { role: currentRole },
      newValue: { changed: ["role"], role },
    })
  })

  it("lets a caller edit a user of equal rank", async () => {
    signedIn("ADMIN")
    target("ADMIN")
    const res = await patch({ password: "synthetic-pass-2" })

    expect(res.status).toBe(200)
    expect(h.userUpdate.mock.calls[0][0].data).toEqual({ password: "hashed:synthetic-pass-2", tokenVersion: { increment: 1 } })
  })

  it("records an email and a role change together", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    await patch({ role: "LOAN_ADMIN", email: "Renamed@acme-lending.example" })

    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "USER_UPDATED",
      oldValue: { email: "target@acme-lending.example", role: "CREDIT_OFFICER" },
      newValue: { changed: ["email", "role"], email: "renamed@acme-lending.example", role: "LOAN_ADMIN" },
    }))
  })

  // The edit form re-sends the current role with every save: that is not a
  // role change and must not read as one in the trail.
  it("does not report a role change when the role sent is the current one", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    const res = await patch({ role: "CREDIT_OFFICER", name: "Renamed" })

    expect(res.status).toBe(200)
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "USER_UPDATED",
      oldValue: undefined,
      newValue: { changed: ["name", "role"] },
    }))
  })
})

describe("DELETE /api/settings/users/[id]", () => {
  it.each(["BRANCH_MANAGER", "ADMIN"])("refuses a %s", async (role) => {
    signedIn(role)
    target("READONLY")
    expect((await del()).status).toBe(403)
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it.each([false, undefined])("refuses a SUPER_ADMIN whose sign-in did not verify TOTP (%j), and removes nothing", async (totpVerified) => {
    signedIn("SUPER_ADMIN", { totpVerified })
    target("READONLY")
    const res = await del()

    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/two-factor/)
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it("answers 404 for a user outside the caller's tenant and removes nothing", async () => {
    signedIn("SUPER_ADMIN")
    h.userFindFirst.mockResolvedValue(null)
    const res = await del("user-of-tenant-b")

    expect(res.status).toBe(404)
    expect(h.userFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "user-of-tenant-b", tenantId: "tenant-a" } }))
    expect(h.transaction).not.toHaveBeenCalled()
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it("lets a TOTP-verified SUPER_ADMIN delete a user with no history", async () => {
    signedIn("SUPER_ADMIN")
    target("ADMIN")
    const res = await del()

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mode: "deleted" })
    expect(h.userDelete).toHaveBeenCalledWith({ where: { id: "target-1" } })
    expect(h.auditLogCreate).toHaveBeenCalledWith({
      data: { tenantId: "tenant-a", userId: "caller-1", action: "USER_DELETED", entity: "User", entityId: "target-1" },
    })
  })
})
