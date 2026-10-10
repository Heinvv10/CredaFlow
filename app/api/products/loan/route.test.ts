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
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanProduct: { create: (...args: unknown[]) => create(...args) },
  },
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { POST } from "./route"

function request(change: Record<string, unknown> = {}) {
  const body = {
    code: "PERSONAL2",
    name: "Personal Loan 2",
    productType: "PERSONAL",
    minAmount: 500,
    maxAmount: 10_000,
    minTermDays: 30,
    maxTermDays: 90,
    interestRatePm: 5,
    interestModel: "REDUCING_BALANCE",
    initiationFeeModel: "FLAT_PCT",
    initiationFeePct: 10,
    initiationFeeMax: 1_000,
    monthlyServiceFee: 69,
    active: true,
    ...change,
  }
  return new NextRequest("http://localhost/api/products/loan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/products/loan bounds validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ id: "product-9", ...data }),
    )
  })

  it("creates a valid non-MICRO30 product with amounts in cents", async () => {
    const response = await POST(request())

    expect(response.status).toBe(201)
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        minAmount: 50_000,
        maxAmount: 1_000_000,
        minTermDays: 30,
        maxTermDays: 90,
      }),
    })
  })

  it("rejects a zero minimum amount without touching the database", async () => {
    const response = await POST(request({ minAmount: 0 }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      invalidFields: ["minAmount"],
    }))
    expect(create).not.toHaveBeenCalled()
  })

  it("rejects a maximum amount below the minimum", async () => {
    const response = await POST(request({ minAmount: 5_000, maxAmount: 100 }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      invalidFields: ["maxAmount"],
    }))
    expect(create).not.toHaveBeenCalled()
  })

  it("rejects a non-integer term", async () => {
    const response = await POST(request({ minTermDays: 30.5 }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      invalidFields: ["minTermDays"],
    }))
    expect(create).not.toHaveBeenCalled()
  })

  it("rejects a missing minimum amount", async () => {
    const body = JSON.parse(await request().text())
    delete body.minAmount
    const response = await POST(new NextRequest("http://localhost/api/products/loan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      invalidFields: ["minAmount"],
    }))
    expect(create).not.toHaveBeenCalled()
  })
})
