import { beforeEach, describe, expect, it, vi } from "vitest"

const findUnique = vi.fn()
const logAudit = vi.fn()
vi.mock("@/lib/prisma", () => ({ prisma: { user: { findUnique: (...a: unknown[]) => findUnique(...a) } } }))
vi.mock("@/lib/audit", () => ({
  AuditAction: {
    SECURITY_LOGIN_SUCCEEDED: "SECURITY_LOGIN_SUCCEEDED", SECURITY_LOGIN_FAILED: "SECURITY_LOGIN_FAILED",
    SECURITY_TOTP_FAILED: "SECURITY_TOTP_FAILED", SECURITY_PERMISSION_DENIED: "SECURITY_PERMISSION_DENIED",
  },
  logAudit: (...a: unknown[]) => logAudit(...a),
}))

import { recordSecurityEvent } from "./security-events"

beforeEach(() => {
  findUnique.mockReset()
  logAudit.mockReset()
})

describe("recordSecurityEvent", () => {
  it("puts a failed sign-in on the chain of the lender whose staff account it targeted", async () => {
    findUnique.mockResolvedValue({ id: "u1", tenantId: "t1" })
    await recordSecurityEvent({ kind: "login_failed", email: "a@lender.invalid", ipAddress: "10.0.0.1", reason: "wrong_password" })
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", userId: "u1", userEmail: "a@lender.invalid", action: "SECURITY_LOGIN_FAILED", ipAddress: "10.0.0.1", newValue: { reason: "wrong_password" },
    }))
  })

  it("writes nothing for a failure against an address that is no staff account", async () => {
    findUnique.mockResolvedValue(null)
    await recordSecurityEvent({ kind: "login_failed", email: "nobody@x.invalid" })
    await recordSecurityEvent({ kind: "totp_failed", email: "nobody@x.invalid" })
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("writes nothing for a failure against an operator account (no lender)", async () => {
    findUnique.mockResolvedValue({ id: "op", tenantId: null })
    await recordSecurityEvent({ kind: "login_failed", email: "op@x.invalid" })
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("records a sign-in and a denial with the tenant it was given, with no lookup", async () => {
    await recordSecurityEvent({ kind: "login_succeeded", tenantId: "t1", userId: "u1", email: "a@x.invalid" })
    await recordSecurityEvent({ kind: "permission_denied", tenantId: "t1", userId: "u1", reason: "requires ADMIN" })
    expect(findUnique).not.toHaveBeenCalled()
    expect(logAudit.mock.calls.map((c) => (c[0] as { action: string }).action)).toEqual(["SECURITY_LOGIN_SUCCEEDED", "SECURITY_PERMISSION_DENIED"])
  })

  it("survives a failed lookup without writing or throwing", async () => {
    findUnique.mockRejectedValue(new Error("db down"))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    await expect(recordSecurityEvent({ kind: "login_failed", email: "a@x.invalid" })).resolves.toBeUndefined()
    expect(logAudit).not.toHaveBeenCalled()
  })
})
