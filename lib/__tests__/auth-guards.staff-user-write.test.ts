import { describe, it, expect, vi, beforeEach } from "vitest"

const { logAuditMock, logAuditStrictMock } = vi.hoisted(() => ({ logAuditMock: vi.fn(), logAuditStrictMock: vi.fn() }))

// Mock Next.js modules that next-auth pulls in at import time.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(), AppRole: undefined }))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAudit: (...args: unknown[]) => logAuditMock(...args),
  logAuditStrict: (...args: unknown[]) => logAuditStrictMock(...args),
}))

import { refuseLockedStaffUserWrite, refuseStaffUserWrite, staffUserWriteConflict, staffUserWriteRefusal, type StaffUser } from "../auth-guards"
import { Prisma } from "@prisma/client"
import type { UserRole } from "@prisma/client"

// Lowest to highest — the order ROLE_HIERARCHY ranks them in.
const allRoles: UserRole[] = [
  "READONLY", "COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "INSURANCE_OFFICER",
  "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN",
]

const caller = (role: string) => ({ role: role as UserRole, totpVerified: true })

describe("staffUserWriteRefusal — assigned role ceiling", () => {
  it("allows a role exactly when it does not outrank the caller (every caller x every role)", () => {
    for (let c = 0; c < allRoles.length; c++) {
      for (let a = 0; a < allRoles.length; a++) {
        const refusal = staffUserWriteRefusal(caller(allRoles[c]!), { targetRole: null, assignedRole: allRoles[a]! })
        if (a <= c) {
          expect(refusal, `${allRoles[c]} assigns ${allRoles[a]}`).toBeNull()
        } else {
          expect(refusal, `${allRoles[c]} assigns ${allRoles[a]}`).toMatchObject({ status: 403, reason: "role_above_caller" })
        }
      }
    }
  })

  it("only a SUPER_ADMIN can assign SUPER_ADMIN", () => {
    for (const role of allRoles) {
      const refusal = staffUserWriteRefusal(caller(role), { targetRole: null, assignedRole: "SUPER_ADMIN" })
      expect(refusal === null).toBe(role === "SUPER_ADMIN")
    }
  })

  // A value that is not a role in the hierarchy is never written, whoever asks.
  it.each([
    ["an unknown role name", "OWNER"],
    ["the portal role", "CLIENT"],
    ["a lower-cased role", "super_admin"],
    ["an empty string", ""],
    ["null", null],
    ["a number", 8],
    ["an array wrapping a role", ["READONLY"]],
    ["an object", { role: "READONLY" }],
  ])("refuses %s with 400, even for a SUPER_ADMIN", (_label, assignedRole) => {
    expect(staffUserWriteRefusal(caller("SUPER_ADMIN"), { targetRole: null, assignedRole }))
      .toMatchObject({ status: 400, reason: "invalid_role" })
    expect(staffUserWriteRefusal(caller("SUPER_ADMIN"), { targetRole: "READONLY", assignedRole }))
      .toMatchObject({ status: 400, reason: "invalid_role" })
  })

  it("does not judge a role when none is being assigned", () => {
    expect(staffUserWriteRefusal(caller("BRANCH_MANAGER"), { targetRole: "READONLY", assignedRole: undefined })).toBeNull()
  })
})

describe("staffUserWriteRefusal — target ceiling", () => {
  it("allows a target exactly when its current role does not outrank the caller (every caller x every target)", () => {
    for (let c = 0; c < allRoles.length; c++) {
      for (let t = 0; t < allRoles.length; t++) {
        const refusal = staffUserWriteRefusal(caller(allRoles[c]!), { targetRole: allRoles[t]!, assignedRole: undefined })
        if (t <= c) {
          expect(refusal, `${allRoles[c]} edits ${allRoles[t]}`).toBeNull()
        } else {
          expect(refusal, `${allRoles[c]} edits ${allRoles[t]}`).toMatchObject({ status: 403, reason: "target_outranks_caller" })
        }
      }
    }
  })

  // Demoting a senior is still an edit of a senior: the assigned role being
  // within the caller's ceiling does not rescue it.
  it("refuses a higher-ranked target even when the role assigned is within the caller's ceiling", () => {
    expect(staffUserWriteRefusal(caller("BRANCH_MANAGER"), { targetRole: "ADMIN", assignedRole: "READONLY" }))
      .toMatchObject({ status: 403, reason: "target_outranks_caller" })
  })

  it("refuses promoting a permitted target above the caller", () => {
    expect(staffUserWriteRefusal(caller("ADMIN"), { targetRole: "LOAN_ADMIN", assignedRole: "SUPER_ADMIN" }))
      .toMatchObject({ status: 403, reason: "role_above_caller" })
  })

  it("fails closed on a role the hierarchy does not rank, on either side", () => {
    expect(staffUserWriteRefusal(caller("FUTURE_ROLE"), { targetRole: "READONLY", assignedRole: undefined }))
      .toMatchObject({ status: 403, reason: "target_outranks_caller" })
    expect(staffUserWriteRefusal(caller("FUTURE_ROLE"), { targetRole: null, assignedRole: "READONLY" }))
      .toMatchObject({ status: 403, reason: "role_above_caller" })
    expect(staffUserWriteRefusal(caller("CLIENT"), { targetRole: null, assignedRole: "READONLY" }))
      .toMatchObject({ status: 403, reason: "role_above_caller" })
    expect(staffUserWriteRefusal(caller("SUPER_ADMIN"), { targetRole: "FUTURE_ROLE" as UserRole, assignedRole: undefined }))
      .toMatchObject({ status: 403, reason: "target_outranks_caller" })
  })
})

describe("staffUserWriteRefusal — TOTP", () => {
  // The claim is set only by a sign-in that checked a code (lib/auth.ts), so a
  // password-only session cannot manage users however senior its role.
  it.each([false, undefined])("refuses a session whose sign-in did not verify TOTP (%j), whatever its role", (totpVerified) => {
    for (const role of allRoles) {
      expect(staffUserWriteRefusal({ role, totpVerified }, { targetRole: null, assignedRole: "READONLY" }))
        .toMatchObject({ status: 403, reason: "totp_required" })
      expect(staffUserWriteRefusal({ role, totpVerified }, { targetRole: "READONLY", assignedRole: undefined }))
        .toMatchObject({ status: 403, reason: "totp_required" })
    }
  })
})

describe("refuseStaffUserWrite", () => {
  const admin: StaffUser = { id: "admin-1", email: "admin@acme-lending.example", name: "Admin", role: "ADMIN", tenantId: "tenant-a", totpVerified: true }

  beforeEach(() => { logAuditMock.mockReset(); logAuditStrictMock.mockReset() })

  it("returns null and writes no audit row when the write is allowed", async () => {
    expect(await refuseStaffUserWrite(admin, { tenantId: "tenant-a", targetId: "u2", targetRole: "LOAN_ADMIN", assignedRole: "ADMIN" })).toBeNull()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("answers 403 and audits a refused role assignment with who tried and what", async () => {
    const res = await refuseStaffUserWrite(admin, { tenantId: "tenant-a", targetId: "u2", targetRole: "LOAN_ADMIN", assignedRole: "SUPER_ADMIN" })
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: "You cannot assign a role above your own" })
    expect(logAuditStrictMock).toHaveBeenCalledTimes(1)
    expect(logAuditStrictMock).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      userId: "admin-1",
      userEmail: "admin@acme-lending.example",
      action: "USER_WRITE_REFUSED",
      entity: "User",
      entityId: "u2",
      newValue: {
        refused: true, reason: "role_above_caller", httpStatus: 403,
        callerRole: "ADMIN", targetRole: "LOAN_ADMIN", assignedRole: "SUPER_ADMIN",
      },
    }, undefined)
  })

  it("audits a refused create (no target) and a refused edit of a senior user", async () => {
    await refuseStaffUserWrite(admin, { tenantId: "tenant-a", targetRole: null, assignedRole: "SUPER_ADMIN" })
    expect(logAuditStrictMock).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "USER_WRITE_REFUSED",
      entityId: undefined,
      newValue: expect.objectContaining({ reason: "role_above_caller", targetRole: null, assignedRole: "SUPER_ADMIN" }),
    }), undefined)

    // The body's role was never validated on this path, so it is not recorded.
    const res = await refuseStaffUserWrite(admin, { tenantId: "tenant-a", targetId: "root-1", targetRole: "SUPER_ADMIN", assignedRole: { junk: "x".repeat(10_000) } })
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: "You cannot modify a user whose role is above your own" })
    expect(logAuditStrictMock).toHaveBeenLastCalledWith(expect.objectContaining({
      entityId: "root-1",
      newValue: { refused: true, reason: "target_outranks_caller", httpStatus: 403, callerRole: "ADMIN", targetRole: "SUPER_ADMIN" },
    }), undefined)
  })

  // Not escalation attempts: nothing above the caller was reached for.
  it("answers an invalid role (400) and a missing TOTP claim (403) without an audit row", async () => {
    const invalid = await refuseStaffUserWrite(admin, { tenantId: "tenant-a", targetRole: null, assignedRole: "OWNER" })
    expect(invalid?.status).toBe(400)
    const noTotp = await refuseStaffUserWrite({ ...admin, totpVerified: false }, { tenantId: "tenant-a", targetRole: null, assignedRole: "READONLY" })
    expect(noTotp?.status).toBe(403)
    expect((await noTotp?.json()).error).toMatch(/two-factor/)
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  // logAudit swallows a failed write; a refusal must never be the thing that
  // goes unrecorded. If the row cannot be written the request fails (500).
  it("fails rather than refusing silently when the refusal cannot be audited", async () => {
    logAuditStrictMock.mockRejectedValue(new Error("audit table unavailable"))
    await expect(refuseStaffUserWrite(admin, { tenantId: "tenant-a", targetRole: null, assignedRole: "SUPER_ADMIN" }))
      .rejects.toThrow("audit table unavailable")
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})

describe("refuseLockedStaffUserWrite", () => {
  const admin: StaffUser = { id: "admin-1", email: "admin@acme-lending.example", name: "Admin", role: "ADMIN", tenantId: "tenant-a", totpVerified: true, tokenVersion: 3 }
  const row = (id: string, role: string, active = true, tokenVersion = 3) => ({ id, role, active, tokenVersion })
  const txWith = (rows: unknown[]) => ({ $executeRaw: vi.fn(), $queryRaw: vi.fn().mockResolvedValue(rows), auditLog: {} }) as never as Parameters<typeof refuseLockedStaffUserWrite>[0]
  const write = { tenantId: "tenant-a", targetId: "u2", assignedRole: undefined }

  beforeEach(() => { logAuditStrictMock.mockReset() })

  it("judges the locked roles, not the session's, and audits a refusal through the transaction", async () => {
    const tx = txWith([row("admin-1", "ADMIN"), row("u2", "SUPER_ADMIN")])
    const result = await refuseLockedStaffUserWrite(tx, admin, write)

    expect(result.refused?.status).toBe(403)
    expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "USER_WRITE_REFUSED", newValue: expect.objectContaining({ targetRole: "SUPER_ADMIN" }),
    }), tx)
  })

  it("uses the caller's locked role, so a demotion since sign-in counts", async () => {
    const result = await refuseLockedStaffUserWrite(txWith([row("admin-1", "READONLY"), row("u2", "CREDIT_OFFICER")]), admin, write)
    expect(result.refused?.status).toBe(403)
    expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      newValue: expect.objectContaining({ callerRole: "READONLY", targetRole: "CREDIT_OFFICER" }),
    }), expect.anything())
  })

  it.each([
    ["inactive", [row("admin-1", "ADMIN", false), row("u2", "CREDIT_OFFICER")]],
    ["missing (another tenant, or deleted)", [row("u2", "CREDIT_OFFICER")]],
  ])("refuses a caller whose row is %s with 403", async (_label, rows) => {
    const result = await refuseLockedStaffUserWrite(txWith(rows), admin, write)
    expect(result.refused?.status).toBe(403)
  })

  // A role change, deactivation or password reset of the caller bumps the
  // version: whatever it was, the session that started this request is stale.
  it("refuses a caller whose row's tokenVersion no longer matches the session", async () => {
    const result = await refuseLockedStaffUserWrite(txWith([row("admin-1", "ADMIN", true, 4), row("u2", "CREDIT_OFFICER")]), admin, write)
    expect(result.refused?.status).toBe(403)
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("refuses a session that carries no tokenVersion", async () => {
    const { tokenVersion: _omit, ...noVersion } = admin
    const result = await refuseLockedStaffUserWrite(txWith([row("admin-1", "ADMIN"), row("u2", "CREDIT_OFFICER")]), noVersion, write)
    expect(result.refused?.status).toBe(403)
  })

  // A row held elsewhere (FOR KEY SHARE by an FK insert) must make the write
  // give up in seconds, not hold the caller's row until Prisma's 5 s timeout.
  it("sets a lock timeout for the transaction before it locks anything", async () => {
    const tx = txWith([row("admin-1", "ADMIN"), row("u2", "CREDIT_OFFICER")]) as never as { $executeRaw: ReturnType<typeof vi.fn>; $queryRaw: ReturnType<typeof vi.fn> }
    await refuseLockedStaffUserWrite(tx as never, admin, write)

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    expect((tx.$executeRaw.mock.calls[0]![0] as string[]).join("?")).toBe("SET LOCAL lock_timeout = '2s'")
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]!)
  })

  it("tells a caller with a stale or missing session version to sign in again", async () => {
    const result = await refuseLockedStaffUserWrite(txWith([row("admin-1", "ADMIN", true, 4), row("u2", "CREDIT_OFFICER")]), admin, write)
    expect(await result.refused?.json()).toEqual({ error: "Your session is out of date. Sign in again." })
  })

  it("answers 404 when the target's row is gone", async () => {
    const result = await refuseLockedStaffUserWrite(txWith([row("admin-1", "ADMIN")]), admin, write)
    expect(result.refused?.status).toBe(404)
  })

  it("returns the locked roles when the write may proceed", async () => {
    expect(await refuseLockedStaffUserWrite(txWith([row("admin-1", "ADMIN"), row("u2", "LOAN_ADMIN")]), admin, { ...write, assignedRole: "ADMIN" }))
      .toEqual({ refused: null, callerRole: "ADMIN", targetRole: "LOAN_ADMIN" })
    expect(await refuseLockedStaffUserWrite(txWith([row("admin-1", "ADMIN")]), admin, { tenantId: "tenant-a", assignedRole: "ADMIN" }))
      .toEqual({ refused: null, callerRole: "ADMIN", targetRole: null })
  })
})

describe("staffUserWriteConflict", () => {
  const known = (code: string, meta?: Record<string, unknown>) => new Prisma.PrismaClientKnownRequestError("x", { code, clientVersion: "test", meta })
  // What Prisma raises when a model query inside the transaction hits lock_timeout.
  const lockTimeout = new Prisma.PrismaClientUnknownRequestError(
    'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "55P03", message: "canceling statement due to lock timeout", severity: "ERROR" }) })',
    { clientVersion: "test" },
  )

  it.each([
    ["a lock timeout on a model query (55P03)", lockTimeout],
    ["a lock timeout on a raw query (P2010 / 55P03)", known("P2010", { code: "55P03" })],
    ["a transaction timeout (P2028)", known("P2028")],
    ["a write conflict or deadlock (P2034)", known("P2034")],
  ])("answers %s with a neutral 409", async (_label, err) => {
    const res = staffUserWriteConflict(err)
    expect(res?.status).toBe(409)
    expect(await res?.json()).toEqual({ error: "This user is being changed elsewhere. Try again." })
  })

  it.each([
    ["a unique violation", known("P2002")],
    ["another raw-query failure", known("P2010", { code: "23505" })],
    ["an unrelated unknown error", new Prisma.PrismaClientUnknownRequestError("connection reset", { clientVersion: "test" })],
    ["a plain error", new Error('code: "55P03"')],
  ])("leaves %s alone", (_label, err) => {
    expect(staffUserWriteConflict(err)).toBeNull()
  })
})
