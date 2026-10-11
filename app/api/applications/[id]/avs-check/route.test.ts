// app/api/applications/[id]/avs-check/route.test.ts
//
// Merge-blocker gate: every Phase 7 collections
// surface must ship dark behind TenantConfig.collectionsEngineEnabled. This
// covers the route's 409 refusal when the flag is off, and confirms
// runAvsCheck is never reached in that case.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const applicationFindFirstMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()
const runAvsCheckMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    cb: (t: { id: string; name: string }) => Promise<unknown>
  ) => cb({ id: "tenant-1", name: "Acme Lending" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findFirst: (a: unknown) => applicationFindFirstMock(a) },
    tenantConfig: { findUnique: (a: unknown) => tenantConfigFindUniqueMock(a) },
  },
}))
vi.mock("@/lib/avs", () => ({ runAvsCheck: (a: unknown) => runAvsCheckMock(a) }))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "app-1" }) }
function makeRequest() {
  return new NextRequest("http://localhost/api/applications/app-1/avs-check", { method: "POST" })
}

describe("POST /api/applications/[id]/avs-check — Phase 7 flag gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "officer@acme-lending.example" } })
    applicationFindFirstMock.mockResolvedValue({ id: "app-1", clientId: "client-1" })
  })

  it("refuses with 409 and never calls runAvsCheck when collectionsEngineEnabled is off", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({ collectionsEngineEnabled: false })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("Collection engine is not enabled for this tenant")
    expect(runAvsCheckMock).not.toHaveBeenCalled()
  })

  it("refuses with 409 when the tenant has no TenantConfig row at all", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue(null)

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(409)
    expect(runAvsCheckMock).not.toHaveBeenCalled()
  })

  it("runs the check when the flag is on", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({ collectionsEngineEnabled: true })
    runAvsCheckMock.mockResolvedValue({ id: "avs-1", passed: true, checks: {} })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(200)
    expect(runAvsCheckMock).toHaveBeenCalledOnce()
  })
})
