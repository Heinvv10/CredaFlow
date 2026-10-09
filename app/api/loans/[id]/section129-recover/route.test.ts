import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const recoverMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (role: string) => requireApiRoleMock(role),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/collections/section129-artifact", () => ({
  recoverStaleSection129Issuance: (args: unknown) => recoverMock(args),
}))

import { POST } from "./route"

const context = { params: Promise.resolve({ id: "loan-1" }) }
function request(body: Record<string, unknown> = { issuanceId: "issue-1" }) {
  return new NextRequest("https://staging.example.test/api/loans/loan-1/section129-recover", {
    method: "POST",
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
})

describe("POST /api/loans/[id]/section129-recover", () => {
  it("requires LOAN_ADMIN", async () => {
    recoverMock.mockResolvedValue({ kind: "STAGING_RELEASED", issuanceId: "issue-1" })

    await POST(request(), context)

    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
  })

  it("releases a stale staged artifact through the guarded recovery service", async () => {
    recoverMock.mockResolvedValue({ kind: "STAGING_RELEASED", issuanceId: "issue-1" })

    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      outcome: "STAGING_RELEASED",
      reconciliationRequired: false,
    })
    expect(recoverMock).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1",
      loanId: "loan-1",
      issuanceId: "issue-1",
      actorId: "admin-1",
    }))
  })

  it("promotes a stale dispatch to reconciliation without unlocking it", async () => {
    recoverMock.mockResolvedValue({
      kind: "RECONCILIATION_REQUIRED",
      issuanceId: "issue-1",
      previousLifecycle: "DISPATCHING",
    })

    const response = await POST(request(), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      outcome: "RECONCILIATION_REQUIRED",
      reconciliationRequired: true,
    })
  })

  it("refuses recovery before the timeout", async () => {
    recoverMock.mockResolvedValue({ kind: "NOT_STALE", issuanceId: "issue-1", lifecycle: "READY" })

    const response = await POST(request(), context)

    expect(response.status).toBe(409)
    expect(recoverMock).toHaveBeenCalledOnce()
  })

  it("keeps the issuance locked when cleanup or auditing fails", async () => {
    recoverMock.mockRejectedValue(new Error("disk permission denied"))

    const response = await POST(request(), context)
    const body = await response.json() as { recoveryRequired: boolean }

    expect(response.status).toBe(503)
    expect(body.recoveryRequired).toBe(true)
  })
})
