import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// The session is the only auth seam mocked: the real requireApiRole and the
// real staff-user write gate (lib/auth-guards.ts) run against it.
const h = vi.hoisted(() => {
  const m = {
    auth: vi.fn(),
    userFindFirst: vi.fn(),
    userFindUnique: vi.fn(),
    userUpdate: vi.fn(),
    userDelete: vi.fn(),
    auditLogCreate: vi.fn(),
    branchFindFirst: vi.fn(),
    applicationCount: vi.fn(),
    logAudit: vi.fn(),
    logAuditStrict: vi.fn(),
    /** The caller's and target's rows as the write's transaction locks them. */
    lockedRows: vi.fn(),
  }
  const tx = {
    $executeRaw: vi.fn(),
    $queryRaw: (...args: unknown[]) => m.lockedRows(...args),
    user: { update: (args: unknown) => m.userUpdate(args), delete: (args: unknown) => m.userDelete(args) },
    auditLog: { create: (args: unknown) => m.auditLogCreate(args) },
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
      findFirst: (args: unknown) => h.userFindFirst(args),
      findUnique: (args: unknown) => h.userFindUnique(args),
      // Every write goes through the locked transaction's client.
      update: () => { throw new Error("user.update outside the transaction") },
      delete: () => { throw new Error("user.delete outside the transaction") },
    },
    auditLog: { create: (args: unknown) => h.auditLogCreate(args) },
    branch: { findFirst: (args: unknown) => h.branchFindFirst(args) },
    loanApplication: { count: (args: unknown) => h.applicationCount(args) },
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
import { DELETE, PATCH } from "./route"

const busy = () => new Prisma.PrismaClientKnownRequestError("lock", { code: "P2034", clientVersion: "test" })
const BUSY = { error: "This user is being changed elsewhere. Try again." }

type Row = { id: string; role: string; active: boolean; tokenVersion?: number }
let locked: { caller?: Row; target?: Row } = {}

const URL = "https://app.example.test/api/settings/users/target-1"

function signedIn(role: string, extra: Record<string, unknown> = {}) {
  locked.caller = { id: "caller-1", role, active: true, tokenVersion: 7 }
  h.auth.mockResolvedValue({
    user: { id: "caller-1", email: "caller@acme-lending.example", name: "Caller", role, tenantId: "tenant-a", totpVerified: true, tokenVersion: 7, ...extra },
  })
}

/** The stored row the tenant-scoped lookup returns for the target. */
function target(role: string, extra: Record<string, unknown> = {}) {
  locked.target = { id: (extra.id as string) ?? "target-1", role, active: true }
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
  locked = {}
  h.lockedRows.mockImplementation(async () => [locked.caller, locked.target].filter(Boolean))
  h.userFindUnique.mockResolvedValue(null)
  h.applicationCount.mockResolvedValue(0)
  h.userUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: "target-1", role: "CREDIT_OFFICER", ...data }))
})

describe("PATCH /api/settings/users/[id] — password policy", () => {
  it.each(["synth-8c", "password12"])("refuses a weak new password (%s) and writes nothing", async (password) => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    const res = await patch({ password })

    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/at least 10 characters|too common/)
    expect(h.userUpdate).not.toHaveBeenCalled()
  })
})

describe("PATCH /api/settings/users/[id] — the audit row says a password was set (never the password)", () => {
  it("records passwordChanged: true on a password change, and not on a rename", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    const res = await patch({ password: "a-long-synthetic-password-1" })
    expect(res.status).toBe(200)
    const logged = h.logAuditStrict.mock.calls.at(-1)![0] as { action: string; newValue: Record<string, unknown> }
    expect(logged).toMatchObject({ action: "USER_UPDATED", newValue: { passwordChanged: true } })
    expect(JSON.stringify(logged)).not.toContain("a-long-synthetic-password-1")
    expect(JSON.stringify(logged)).not.toContain("hashed:")

    h.logAuditStrict.mockClear()
    await patch({ name: "Renamed" })
    expect((h.logAuditStrict.mock.calls.at(-1)![0] as { newValue: Record<string, unknown> }).newValue).not.toHaveProperty("passwordChanged")
  })
})

describe("PATCH /api/settings/users/[id] — role ceiling", () => {
  // Equal rank is as out of reach as higher rank: a password, email or demotion
  // on a peer's account takes it over.
  it.each([
    ["ADMIN", "ADMIN", { password: "synthetic-pass-2" }],
    ["ADMIN", "ADMIN", { role: "READONLY" }],
    ["ADMIN", "ADMIN", { active: false }],
    ["SUPER_ADMIN", "SUPER_ADMIN", { role: "ADMIN" }],
    ["SUPER_ADMIN", "SUPER_ADMIN", { email: "takeover@acme-lending.example" }],
    ["BRANCH_MANAGER", "BRANCH_MANAGER", { name: "Renamed" }],
  ])("refuses a %s editing a %s (%j), writes nothing and audits the attempt", async (callerRole, targetRole, body) => {
    signedIn(callerRole)
    target(targetRole)
    const res = await patch(body)

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "You cannot modify a user whose role is the same as your own" })
    expect(h.userUpdate).not.toHaveBeenCalled()
    expect(h.logAuditStrict).toHaveBeenCalledTimes(1)
    expect(h.logAuditStrict).toHaveBeenCalledWith(refusedAudit("target_same_rank"), undefined)
  })

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
    expect(h.logAuditStrict).toHaveBeenCalledWith(refusedAudit("role_above_caller"), undefined)
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
    expect(h.logAuditStrict).toHaveBeenCalledWith(refusedAudit("target_outranks_caller"), undefined)
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
  ])("lets a %s change a %s to %s and audits the old and new role", async (callerRole, currentRole, role) => {
    signedIn(callerRole)
    target(currentRole)
    const res = await patch({ role })

    expect(res.status).toBe(200)
    expect(h.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "target-1" },
      data: { role, tokenVersion: { increment: 1 } },
    }))
    expect(h.logAuditStrict).toHaveBeenCalledTimes(1)
    expect(h.logAuditStrict).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      action: "USER_UPDATED",
      entity: "User",
      entityId: "target-1",
      userId: "caller-1",
      oldValue: { role: currentRole },
      newValue: { changed: ["role"], role },
    }, h.tx)
    expect(h.logAudit).not.toHaveBeenCalled()
  })

  it("lets a caller edit their own row at their own rank", async () => {
    signedIn("ADMIN")
    target("ADMIN", { id: "caller-1" })
    const res = await patch({ name: "Renamed" }, "caller-1")

    expect(res.status).toBe(200)
    expect(h.userUpdate.mock.calls[0][0].data).toEqual({ name: "Renamed" })
  })

  it("records an email and a role change together", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    await patch({ role: "LOAN_ADMIN", email: "Renamed@acme-lending.example" })

    expect(h.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "USER_UPDATED",
      oldValue: { email: "target@acme-lending.example", role: "CREDIT_OFFICER" },
      newValue: { changed: ["email", "role"], email: "renamed@acme-lending.example", role: "LOAN_ADMIN" },
    }), h.tx)
  })

  // The edit form re-sends the current role with every save: that is not a
  // role change and must not read as one in the trail.
  it("does not report a role change when the role sent is the current one", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    const res = await patch({ role: "CREDIT_OFFICER", name: "Renamed" })

    expect(res.status).toBe(200)
    expect(h.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "USER_UPDATED",
      oldValue: undefined,
      newValue: { changed: ["name", "role"] },
    }), h.tx)
  })
})

// The first check reads the target, then the route probes and hashes before it
// writes. The write re-checks on the rows its transaction has locked, so a
// role change in between cannot carry it onto an account the caller may no
// longer touch.
describe("PATCH /api/settings/users/[id] — the locked re-check", () => {
  it("refuses when the target was promoted above the caller after the first check, and audits it in the transaction", async () => {
    signedIn("ADMIN")
    target("LOAN_ADMIN")
    locked.target = { id: "target-1", role: "SUPER_ADMIN", active: true }
    const res = await patch({ password: "synthetic-pass-2" })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "You cannot modify a user whose role is above your own" })
    expect(h.userUpdate).not.toHaveBeenCalled()
    expect(h.logAuditStrict).toHaveBeenCalledTimes(1)
    expect(h.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "USER_WRITE_REFUSED",
      entityId: "target-1",
      newValue: expect.objectContaining({ reason: "target_outranks_caller", callerRole: "ADMIN", targetRole: "SUPER_ADMIN" }),
    }), h.tx)
  })

  it("refuses when the caller was demoted below the target after the first check", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    locked.caller = { id: "caller-1", role: "READONLY", active: true, tokenVersion: 7 }
    const res = await patch({ email: "renamed@acme-lending.example" })

    expect(res.status).toBe(403)
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it("refuses when the caller was demoted below the role being assigned", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    locked.caller = { id: "caller-1", role: "BRANCH_MANAGER", active: true, tokenVersion: 7 }
    const res = await patch({ role: "ADMIN" })

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "You cannot assign a role above your own" })
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ["deactivated", { id: "caller-1", role: "ADMIN", active: false, tokenVersion: 7 }],
    ["signed out elsewhere (tokenVersion bumped)", { id: "caller-1", role: "ADMIN", active: true, tokenVersion: 8 }],
    ["removed from the tenant", undefined],
  ])("refuses when the caller was %s after the first check", async (_label, caller) => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    locked.caller = caller
    const res = await patch({ password: "synthetic-pass-2" })

    expect(res.status).toBe(403)
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it("answers 404 when the target left the tenant after the first check", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    locked.target = undefined
    const res = await patch({ password: "synthetic-pass-2" })

    expect(res.status).toBe(404)
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  // The stale read says the role is unchanged; the locked row says otherwise.
  it("reports a role change judged against the locked row, not the first read", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    locked.target = { id: "target-1", role: "LOAN_ADMIN", active: true }
    const res = await patch({ role: "CREDIT_OFFICER" })

    expect(res.status).toBe(200)
    expect(h.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "USER_UPDATED", oldValue: { role: "LOAN_ADMIN" }, newValue: { changed: ["role"], role: "CREDIT_OFFICER" },
    }), h.tx)
  })

  it("records the role the locked row had as the old role", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    locked.target = { id: "target-1", role: "LOAN_ADMIN", active: true }
    const res = await patch({ role: "ADMIN" })

    expect(res.status).toBe(200)
    expect(h.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({
      action: "USER_UPDATED", oldValue: { role: "LOAN_ADMIN" }, newValue: { changed: ["role"], role: "ADMIN" },
    }), h.tx)
  })

  it("locks the caller's and the target's rows, in the caller's tenant", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    await patch({ name: "Renamed" })

    expect(h.lockedRows).toHaveBeenCalledTimes(1)
    const query = h.lockedRows.mock.calls[0][0] as { sql: string; values: unknown[] }
    expect(query.sql).toMatch(/FOR NO KEY UPDATE/)
    expect(query.sql).toMatch(/"tenantId" = \?/)
    expect(query.values).toEqual(expect.arrayContaining(["caller-1", "target-1", "tenant-a"]))
  })

  // The row is held by another transaction: the write gives up with a 409, and
  // its transaction (the update and the audit row) is rolled back.
  it("answers 409 when the write cannot take its lock in time", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    h.userUpdate.mockRejectedValue(busy())
    const res = await patch({ email: "renamed@acme-lending.example" })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(BUSY)
    expect(h.logAuditStrict).not.toHaveBeenCalled()
  })

  // The update and its audit row commit together or not at all.
  it("fails the whole write when the USER_UPDATED row cannot be written", async () => {
    signedIn("ADMIN")
    target("CREDIT_OFFICER")
    h.logAuditStrict.mockRejectedValue(new Error("audit table unavailable"))

    await expect(patch({ role: "LOAN_ADMIN" })).rejects.toThrow("audit table unavailable")
  })
})

describe("DELETE /api/settings/users/[id]", () => {
  it("refuses a SUPER_ADMIN removing another SUPER_ADMIN, and removes and deactivates nothing", async () => {
    signedIn("SUPER_ADMIN")
    target("SUPER_ADMIN")
    const res = await del()

    expect(res.status).toBe(403)
    expect(h.userDelete).not.toHaveBeenCalled()
    expect(h.userUpdate).not.toHaveBeenCalled()
    expect(h.logAuditStrict).toHaveBeenCalledWith(refusedAudit("target_same_rank"), undefined)
  })

  it.each([
    ["with no history (hard delete)", null],
    ["with history (deactivation)", { id: "fp-1" }],
  ])("refuses a SUPER_ADMIN demoted after the first check, for a target %s", async (_label, fitAndProper) => {
    signedIn("SUPER_ADMIN")
    target("ADMIN", { fitAndProper })
    locked.caller = { id: "caller-1", role: "ADMIN", active: true, tokenVersion: 7 }
    const res = await del()

    expect(res.status).toBe(403)
    expect(h.userDelete).not.toHaveBeenCalled()
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it("answers 404 when the target was removed after the first check, and removes nothing", async () => {
    signedIn("SUPER_ADMIN")
    target("ADMIN")
    locked.target = undefined
    const res = await del()

    expect(res.status).toBe(404)
    expect(h.userDelete).not.toHaveBeenCalled()
  })

  it.each([
    ["with no history (hard delete)", null, "userDelete"],
    ["with history (deactivation)", { id: "fp-1" }, "userUpdate"],
  ] as const)("answers 409 when the removal of a target %s cannot take its lock in time", async (_label, fitAndProper, write) => {
    signedIn("SUPER_ADMIN")
    target("ADMIN", { fitAndProper })
    h[write].mockRejectedValue(busy())
    const res = await del()

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual(BUSY)
  })

  it("deactivates a user with history and audits it in the same transaction", async () => {
    signedIn("SUPER_ADMIN")
    target("ADMIN", { fitAndProper: { id: "fp-1" } })
    const res = await del()

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mode: "deactivated" })
    expect(h.userUpdate).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "target-1" }, data: { active: false, tokenVersion: { increment: 1 } } }))
    expect(h.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "USER_DEACTIVATED", entityId: "target-1" }), h.tx)
  })

  it("deactivates, never deletes, a user recorded as input staff on an application (no foreign key would have kept them)", async () => {
    signedIn("SUPER_ADMIN")
    target("ADMIN")
    h.applicationCount.mockResolvedValue(2)
    const res = await del()

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ mode: "deactivated" })
    expect(h.applicationCount).toHaveBeenCalledWith({ where: { tenantId: "tenant-a", inputStaffIds: { has: "target-1" } } })
    expect(h.userDelete).not.toHaveBeenCalled()
  })

  it.each(["BRANCH_MANAGER", "ADMIN"])("refuses a %s", async (role) => {
    signedIn(role)
    target("READONLY")
    expect((await del()).status).toBe(403)
    expect(h.userDelete).not.toHaveBeenCalled()
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it.each([false, undefined])("refuses a SUPER_ADMIN whose sign-in did not verify TOTP (%j), and removes nothing", async (totpVerified) => {
    signedIn("SUPER_ADMIN", { totpVerified })
    target("READONLY")
    const res = await del()

    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/two-factor/)
    expect(h.userDelete).not.toHaveBeenCalled()
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it("answers 404 for a user outside the caller's tenant and removes nothing", async () => {
    signedIn("SUPER_ADMIN")
    h.userFindFirst.mockResolvedValue(null)
    const res = await del("user-of-tenant-b")

    expect(res.status).toBe(404)
    expect(h.userFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "user-of-tenant-b", tenantId: "tenant-a" } }))
    expect(h.userDelete).not.toHaveBeenCalled()
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

describe("the automated decisioning account (isSystem)", () => {
  it("a SUPER_ADMIN cannot edit it (PATCH 403), and nothing is written", async () => {
    signedIn("SUPER_ADMIN")
    target("LOAN_ADMIN", { isSystem: true })
    const res = await patch({ password: "a-new-long-password-1", active: true })
    expect(res.status).toBe(403)
    expect(h.userUpdate).not.toHaveBeenCalled()
  })

  it("nor remove it (DELETE 403)", async () => {
    signedIn("SUPER_ADMIN")
    target("LOAN_ADMIN", { isSystem: true })
    const res = await del()
    expect(res.status).toBe(403)
    expect(h.userDelete).not.toHaveBeenCalled()
  })

  it("the locked re-check refuses it even if the first read missed the flag", async () => {
    signedIn("SUPER_ADMIN")
    target("LOAN_ADMIN", { isSystem: false })
    locked.target = { id: "target-1", role: "LOAN_ADMIN", active: false, isSystem: true } as never
    const res = await patch({ name: "Renamed" })
    expect(res.status).toBe(403)
    expect(h.userUpdate).not.toHaveBeenCalled()
  })
})
