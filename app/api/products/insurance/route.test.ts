import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { requireApiRole, create } = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  create: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    callback: (tenant: { id: string }) => unknown,
  ) => callback({ id: "tenant-1" }),
}))
// The lender's FSP number (TenantConfig.fscaNumber).
const fsp = vi.hoisted(() => ({ number: "12345" as string | null }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    insuranceProduct: { create: (...args: unknown[]) => create(...args) },
    tenantConfig: { findUnique: async () => ({ fscaNumber: fsp.number }) },
  },
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { POST } from "./route"

function request(change: Record<string, unknown> = {}) {
  return new NextRequest("http://localhost/api/products/insurance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "CL-1",
      name: "Synthetic Credit Life",
      type: "CREDIT_LIFE",
      premiumAmount: 22.5,
      sumAssured: 5_000,
      ...change,
    }),
  })
}

describe("POST /api/products/insurance credit-life terms", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
    create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "product-1", ...data }),
    )
  })

  it("creates a credit-life product with a positive premium and cover", async () => {
    const response = await POST(request())
    expect(response.status).toBe(201)
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: "CREDIT_LIFE", premiumAmount: 22.5, sumAssured: 5_000 }),
    })
  })

  it.each([
    [{ premiumAmount: 0 }, ["premiumAmount"]],
    [{ premiumAmount: -1 }, ["premiumAmount"]],
    [{ sumAssured: 0 }, ["sumAssured"]],
    [{ premiumAmount: "abc", sumAssured: -5 }, ["premiumAmount", "sumAssured"]],
  ])("refuses %j with 422 and writes nothing", async (change, invalidFields) => {
    const response = await POST(request(change))
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ invalidFields })
    expect(create).not.toHaveBeenCalled()
  })

  it("does not apply the rule to other product types", async () => {
    const response = await POST(request({ type: "FUNERAL_COVER", premiumAmount: 0 }))
    expect(response.status).toBe(201)
  })
})

// #143 blind review: a lender with no FSP number offers no cover, and the
// approval guard counts any active credit-life product as an offer.
describe("POST /api/products/insurance without an FSP number", () => {
  it("refuses an active credit-life product with 409 and the Settings hint", async () => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
    fsp.number = null
    try {
      const res = await POST(request())
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ code: "LENDER_FSP_NOT_CONFIGURED" })
      expect(create).not.toHaveBeenCalled()
    } finally {
      fsp.number = "12345"
    }
  })
})
