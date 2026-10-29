import { beforeEach, describe, expect, it, vi } from "vitest"

const logAudit = vi.fn()
vi.mock("@/lib/audit", () => ({
  AuditAction: {
    SECURITY_LOGIN_SUCCEEDED: "SECURITY_LOGIN_SUCCEEDED", SECURITY_LOGIN_FAILED: "SECURITY_LOGIN_FAILED",
    SECURITY_TOTP_FAILED: "SECURITY_TOTP_FAILED", SECURITY_PERMISSION_DENIED: "SECURITY_PERMISSION_DENIED",
  },
  logAudit: (...a: unknown[]) => logAudit(...a),
}))

vi.mock("@/lib/observability/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import { recordSecurityEvent, resetSecurityEventWindows, SECURITY_EVENT_WINDOW_MS } from "./security-events"

const failed = { kind: "login_failed" as const, tenantId: "t1", userId: "u1", email: "a@lender.invalid", ipAddress: "10.0.0.1", reason: "wrong_password" }

beforeEach(() => {
  logAudit.mockReset()
  resetSecurityEventWindows()
})

describe("recordSecurityEvent", () => {
  it("writes the event on the given tenant and user, with no lookup", async () => {
    await recordSecurityEvent(failed, 0)
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", userId: "u1", userEmail: "a@lender.invalid", action: "SECURITY_LOGIN_FAILED", entity: "Session", ipAddress: "10.0.0.1", newValue: { reason: "wrong_password" },
    }))
  })

  it("writes one row per (tenant, user, kind) per window and counts what it held back on the next", async () => {
    await recordSecurityEvent(failed, 0)
    for (let i = 1; i <= 4; i++) await recordSecurityEvent(failed, i * 1000)
    expect(logAudit).toHaveBeenCalledTimes(1)
    await recordSecurityEvent(failed, SECURITY_EVENT_WINDOW_MS + 1)
    expect(logAudit).toHaveBeenCalledTimes(2)
    expect(logAudit.mock.calls[1][0]).toMatchObject({ newValue: { reason: "wrong_password", suppressedSincePrevious: 4 } })
  })

  it("never suppresses a successful sign-in", async () => {
    const ok = { ...failed, kind: "login_succeeded" as const, reason: undefined }
    for (let i = 0; i < 4; i++) await recordSecurityEvent(ok, i * 1000)
    expect(logAudit).toHaveBeenCalledTimes(4)
  })

  it("records a failure from a new source address even inside the window, and still throttles one address", async () => {
    await recordSecurityEvent(failed, 0)
    await recordSecurityEvent(failed, 1000)
    await recordSecurityEvent({ ...failed, ipAddress: "203.0.113.9" }, 2000)
    await recordSecurityEvent({ ...failed, ipAddress: "203.0.113.9" }, 3000)
    expect(logAudit.mock.calls.map((c) => (c[0] as { ipAddress: string }).ipAddress)).toEqual(["10.0.0.1", "203.0.113.9"])
  })

  it("keeps kinds, users and lenders apart", async () => {
    await recordSecurityEvent(failed, 0)
    await recordSecurityEvent({ ...failed, kind: "totp_failed" }, 1)
    await recordSecurityEvent({ ...failed, userId: "u2" }, 2)
    await recordSecurityEvent({ ...failed, tenantId: "t2" }, 3)
    expect(logAudit).toHaveBeenCalledTimes(4)
  })

  it("never throws into the sign-in when the audit write fails, and a failed write does not open the window", async () => {
    logAudit.mockRejectedValueOnce(new Error("db down"))
    await expect(recordSecurityEvent(failed, 0)).resolves.toBeUndefined()
    await recordSecurityEvent(failed, 1000)
    expect(logAudit).toHaveBeenCalledTimes(2)
  })
})
