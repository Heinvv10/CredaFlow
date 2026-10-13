import { NextRequest, NextResponse } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const requireApiRoleMock = vi.fn()
const findFirstMock = vi.fn()
const updateManyMock = vi.fn()
const logAuditStrictMock = vi.fn()
const tx = {
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

beforeEach(() => {
  vi.resetAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "admin@test.invalid", role: "LOAN_ADMIN", tenantId: "t1", totpVerified: true } })
  findFirstMock.mockResolvedValue({ id: "flag-1", check: "SALARY_MATCH", code: "NO_SALARY_CREDIT", application: { status: "UNDER_REVIEW" } })
  updateManyMock.mockResolvedValue({ count: 1 })
  logAuditStrictMock.mockResolvedValue(undefined)
})

describe("POST /api/applications/[id]/checks/[flagId]/clear", () => {
  it("clears an OPEN flag with the reason and audits it in the same transaction", async () => {
    const res = await post({ reason: `  ${REASON}  ` })
    expect(res.status).toBe(200)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
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
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", role: "LOAN_ADMIN", tenantId: "t1", totpVerified: false } })
    const res = await post({ reason: REASON })
    expect(res.status).toBe(403)
    expect(updateManyMock).not.toHaveBeenCalled()
  })

  it("refuses a reason under 15 characters once trimmed", async () => {
    const res = await post({ reason: "   fourteen chrs   ".replace("chrs", "chr") })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ reason: "too_short" })
    expect((await post({})).status).toBe(400)
    expect(findFirstMock).not.toHaveBeenCalled()
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

  it("409s a flag on a decided application", async () => {
    findFirstMock.mockResolvedValue({ id: "flag-1", check: "SALARY_MATCH", code: "X", application: { status: "APPROVED" } })
    expect((await post({ reason: REASON })).status).toBe(409)
    expect(updateManyMock).not.toHaveBeenCalled()
  })
})
