import { NextRequest, NextResponse } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const requireApiRoleMock = vi.fn()
const findFirstMock = vi.fn()
const updateManyMock = vi.fn()
const logAuditStrictMock = vi.fn()
const lockMock = vi.fn()
const tx = {
  $queryRaw: (...a: unknown[]) => lockMock(...a),
  applicationCheckFlag: {
    findFirst: (a: unknown) => findFirstMock(a),
    updateMany: (a: unknown) => updateManyMock(a),
  },
}

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: string) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (cb: (t: typeof tx) => Promise<unknown>) => cb(tx) } }))
vi.mock("@/lib/audit", () => ({
  AuditAction: { CREDIT_CHECK_FLAG_CLEARED: "CREDIT_CHECK_FLAG_CLEARED" },
  logAuditStrict: (...a: unknown[]) => logAuditStrictMock(...a),
}))
vi.mock("@/lib/credit-checks/recompute", () => ({ RECOMPUTE_STATUSES: ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] }))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "app-1", flagId: "flag-1" }) }
const post = (body: unknown) => POST(new NextRequest("https://acme.example/api/applications/app-1/checks/flag-1/clear", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
}), ctx)
const REASON = "Salary paid in cash; confirmed with the employer."

afterEach(() => vi.unstubAllEnvs())

beforeEach(() => {
  vi.resetAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "admin@test.invalid", role: "LOAN_ADMIN", tenantId: "t1", totpVerified: true } })
  lockMock.mockResolvedValue([{ status: "UNDER_REVIEW" }])
  findFirstMock.mockResolvedValue({ id: "flag-1", check: "SALARY_MATCH", code: "NO_SALARY_CREDIT" })
  updateManyMock.mockResolvedValue({ count: 1 })
  logAuditStrictMock.mockResolvedValue(undefined)
})

describe("POST /api/applications/[id]/checks/[flagId]/clear", () => {
  it("clears an OPEN flag with the reason and audits it in the same transaction", async () => {
    const res = await post({ reason: `  ${REASON}  ` })
    expect(res.status).toBe(200)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
    // The application row lock is taken before the flag is read or written.
    expect(String(lockMock.mock.calls[0][0])).toContain("FOR NO KEY UPDATE")
    expect(lockMock.mock.invocationCallOrder[0]).toBeLessThan(updateManyMock.mock.invocationCallOrder[0])
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: "flag-1", tenantId: "t1", status: "OPEN" },
      data: { status: "CLEARED", clearedById: "u1", clearedAt: expect.any(Date), clearReason: REASON },
    })
    expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1", userId: "u1", action: "CREDIT_CHECK_FLAG_CLEARED", entity: "ApplicationCheckFlag", entityId: "flag-1",
      newValue: expect.objectContaining({ status: "CLEARED", reason: REASON, code: "NO_SALARY_CREDIT", applicationId: "app-1" }),
    }), tx)
  })

  it("passes through a role refusal", async () => {
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await post({ reason: REASON })).status).toBe(403)
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it("refuses a session that did not verify two-factor authentication", async () => {
    vi.stubEnv("DEMO_MODE", "")
    vi.stubEnv("DEMO_CLEAR_STAFF_TOTP", "")
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", role: "LOAN_ADMIN", tenantId: "t1", totpVerified: false } })
    const res = await post({ reason: REASON })
    expect(res.status).toBe(403)
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  describe("a demo stack without TOTP (DEMO_MODE and DEMO_CLEAR_STAFF_TOTP both exactly true)", () => {
    const passwordOnly = () =>
      requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "admin@test.invalid", role: "LOAN_ADMIN", tenantId: "t1", totpVerified: false } })

    it("lets a password-only session clear and records the waiver in the audit row", async () => {
      vi.stubEnv("DEMO_MODE", "true")
      vi.stubEnv("DEMO_CLEAR_STAFF_TOTP", "true")
      passwordOnly()
      expect((await post({ reason: REASON })).status).toBe(200)
      expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
        newValue: expect.objectContaining({ status: "CLEARED", twoFactor: "waived: demo stack without TOTP" }),
      }), tx)
    })

    it("does not mark a TOTP-verified clearance as waived", async () => {
      vi.stubEnv("DEMO_MODE", "true")
      vi.stubEnv("DEMO_CLEAR_STAFF_TOTP", "true")
      expect((await post({ reason: REASON })).status).toBe(200)
      expect(logAuditStrictMock.mock.calls[0][0].newValue).not.toHaveProperty("twoFactor")
    })

    it.each([
      ["only DEMO_MODE", { DEMO_MODE: "true", DEMO_CLEAR_STAFF_TOTP: "" }],
      ["only DEMO_CLEAR_STAFF_TOTP", { DEMO_MODE: "", DEMO_CLEAR_STAFF_TOTP: "true" }],
      ["DEMO_MODE not exactly true", { DEMO_MODE: "TRUE", DEMO_CLEAR_STAFF_TOTP: "true" }],
      ["DEMO_CLEAR_STAFF_TOTP not exactly true", { DEMO_MODE: "true", DEMO_CLEAR_STAFF_TOTP: "true " }],
    ])("still refuses a password-only session with %s", async (_what, env) => {
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
      passwordOnly()
      expect((await post({ reason: REASON })).status).toBe(403)
      expect(updateManyMock).not.toHaveBeenCalled()
    })
  })

  it("refuses a reason of 14 characters once trimmed and accepts 15", async () => {
    const res = await post({ reason: `   ${"x".repeat(14)}   ` })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "too_short" })
    expect((await post({})).status).toBe(400)
    expect(findFirstMock).not.toHaveBeenCalled()
    expect((await post({ reason: "x".repeat(15) })).status).toBe(200)
  })

  it("counts characters as the database does: eight emoji are eight, not sixteen", async () => {
    expect((await post({ reason: "🙂".repeat(8) })).status).toBe(400)
    expect((await post({ reason: "🙂".repeat(15) })).status).toBe(200)
  })

  it("refuses control characters in a reason, which Postgres would reject as a 500", async () => {
    const res = await post({ reason: "Reviewed by hand\u0000 and fine" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "invalid" })
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it("refuses a reason over 1000 characters", async () => {
    const res = await post({ reason: "x".repeat(1001) })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "too_long" })
    expect((await post({ reason: "x".repeat(1000) })).status).toBe(200)
  })

  it("404s a flag of another application or tenant", async () => {
    findFirstMock.mockResolvedValue(null)
    expect((await post({ reason: REASON })).status).toBe(404)
    expect(findFirstMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "flag-1", tenantId: "t1", applicationId: "app-1" } }))
  })

  it("409s a flag that is not OPEN, writing no audit", async () => {
    updateManyMock.mockResolvedValue({ count: 0 })
    expect((await post({ reason: REASON })).status).toBe(409)
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("409s a flag on a decided application, read under the lock", async () => {
    lockMock.mockResolvedValue([{ status: "APPROVED" }])
    expect((await post({ reason: REASON })).status).toBe(409)
    expect(updateManyMock).not.toHaveBeenCalled()
  })
})
