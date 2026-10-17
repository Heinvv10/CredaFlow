import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const applicationFindFirstMock = vi.fn()
const tenantConfigFindUniqueMock = vi.fn()
const runAvsCheckMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: string) => requireApiRoleMock(role) }))
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

describe("POST /api/applications/[id]/avs-check — AVS feature flags", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "officer@acme-lending.example" } })
    applicationFindFirstMock.mockResolvedValue({ id: "app-1", clientId: "client-1" })
  })

  it("refuses with 409 and never calls runAvsCheck when collectionsEngineEnabled is off", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue({ collectionsEngineEnabled: false })

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe("Neither collections nor payouts is enabled for this tenant")
    expect(runAvsCheckMock).not.toHaveBeenCalled()
  })

  it("refuses with 409 when the tenant has no TenantConfig row at all", async () => {
    tenantConfigFindUniqueMock.mockResolvedValue(null)

    const res = await POST(makeRequest(), ctx)

    expect(res.status).toBe(409)
    expect(runAvsCheckMock).not.toHaveBeenCalled()
  })

  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])("runs AVS when payouts=%s and collections=%s", async (payoutsEngineEnabled, collectionsEngineEnabled) => {
    tenantConfigFindUniqueMock.mockResolvedValue({ payoutsEngineEnabled, collectionsEngineEnabled })
    runAvsCheckMock.mockResolvedValue({ id: "avs-1", passed: true, checks: {} })
    const res = await POST(makeRequest(), ctx)
    expect(res.status).toBe(200)
    expect(runAvsCheckMock).toHaveBeenCalledOnce()
  })
  it("retains the staff role refusal before any provider call", async () => {
    requireApiRoleMock.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    expect((await POST(makeRequest(), ctx)).status).toBe(403)
    expect(requireApiRoleMock).toHaveBeenCalledWith("CREDIT_OFFICER")
    expect(runAvsCheckMock).not.toHaveBeenCalled()
  })
  it("retains tenant-scoped application lookup", async () => {
    applicationFindFirstMock.mockResolvedValue(null)
    expect((await POST(makeRequest(), ctx)).status).toBe(404)
    expect(applicationFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "app-1", tenantId: "tenant-1" } }))
    expect(runAvsCheckMock).not.toHaveBeenCalled()
  })
  it("does not route entity bank verification through the consumer AVS flow", async () => {
    applicationFindFirstMock.mockResolvedValue({ id: "app-1", clientId: null })
    expect((await POST(makeRequest(), ctx)).status).toBe(409)
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
