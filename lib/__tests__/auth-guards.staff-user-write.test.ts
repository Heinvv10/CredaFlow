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

import { refuseStaffUserWrite, staffUserWriteRefusal, type StaffUser } from "../auth-guards"
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
    })
  })

  it("audits a refused create (no target) and a refused edit of a senior user", async () => {
    await refuseStaffUserWrite(admin, { tenantId: "tenant-a", targetRole: null, assignedRole: "SUPER_ADMIN" })
    expect(logAuditStrictMock).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "USER_WRITE_REFUSED",
      entityId: undefined,
      newValue: expect.objectContaining({ reason: "role_above_caller", targetRole: null, assignedRole: "SUPER_ADMIN" }),
    }))

    // The body's role was never validated on this path, so it is not recorded.
    const res = await refuseStaffUserWrite(admin, { tenantId: "tenant-a", targetId: "root-1", targetRole: "SUPER_ADMIN", assignedRole: { junk: "x".repeat(10_000) } })
    expect(res?.status).toBe(403)
    expect(await res?.json()).toEqual({ error: "You cannot modify a user whose role is above your own" })
    expect(logAuditStrictMock).toHaveBeenLastCalledWith(expect.objectContaining({
      entityId: "root-1",
      newValue: { refused: true, reason: "target_outranks_caller", httpStatus: 403, callerRole: "ADMIN", targetRole: "SUPER_ADMIN" },
    }))
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
