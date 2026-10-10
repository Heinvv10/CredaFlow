import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { requireApiRole, findUnique, update } = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    callback: (tenant: { id: string }) => unknown,
  ) => callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    insuranceProduct: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      update: (...args: unknown[]) => update(...args),
    },
  },
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { PUT } from "./route"

const ctx = { params: Promise.resolve({ id: "product-1" }) }

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/products/insurance/product-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "CL-1", name: "Synthetic Credit Life", premiumAmount: 22.5, sumAssured: 5_000, ...body }),
  })
}

describe("PUT /api/products/insurance/[id] credit-life terms", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
    findUnique.mockResolvedValue({
      id: "product-1",
      type: "CREDIT_LIFE",
      premiumAmount: 22.5,
      sumAssured: 5_000,
      commissionRate: 0,
    })
    update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "product-1", ...data }),
    )
  })

  it("saves a credit-life product with a positive premium and cover", async () => {
    const response = await PUT(request({ type: "CREDIT_LIFE" }), ctx)
    expect(response.status).toBe(200)
    expect(update).toHaveBeenCalledOnce()
  })

  it("refuses a zero premium on a credit-life product with 422 and writes nothing", async () => {
    const response = await PUT(request({ type: "CREDIT_LIFE", premiumAmount: 0 }), ctx)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ invalidFields: ["premiumAmount"] })
    expect(update).not.toHaveBeenCalled()
  })

  it("judges the stored type when the body does not send one", async () => {
    const response = await PUT(request({ sumAssured: 0 }), ctx)
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ invalidFields: ["sumAssured"] })
    expect(update).not.toHaveBeenCalled()
  })

  it("refuses turning a product into credit life without positive terms", async () => {
    findUnique.mockResolvedValue({ id: "product-1", type: "FUNERAL_COVER", premiumAmount: 0, sumAssured: 0, commissionRate: 0 })
    const response = await PUT(request({ type: "CREDIT_LIFE", premiumAmount: 0, sumAssured: 0 }), ctx)
    expect(response.status).toBe(422)
    expect(update).not.toHaveBeenCalled()
  })

  it("does not apply the rule to other product types", async () => {
    findUnique.mockResolvedValue({ id: "product-1", type: "FUNERAL_COVER", premiumAmount: 0, sumAssured: 0, commissionRate: 0 })
    const response = await PUT(request({ type: "FUNERAL_COVER", premiumAmount: 0 }), ctx)
    expect(response.status).toBe(200)
  })
})
