import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  requireApiRole,
  transaction,
  queryRaw,
  findUnique,
  update,
  count,
  auditCreate,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  count: vi.fn(),
  auditCreate: vi.fn(),
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
    $transaction: (...args: unknown[]) => transaction(...args),
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  AuditAction: {
    LOAN_PRODUCT_UPDATED: "LOAN_PRODUCT_UPDATED",
    LOAN_PRODUCT_DEACTIVATED: "LOAN_PRODUCT_DEACTIVATED",
  },
}))

import { PUT } from "./route"

const before = {
  id: "product-1",
  tenantId: "tenant-1",
  code: "MICRO30",
  name: "30-Day Micro Loan",
  productType: "MICRO",
  minAmount: 50_000,
  maxAmount: 1_000_000,
  minTermDays: 30,
  maxTermDays: 30,
  interestRatePm: 0.05,
  interestModel: "DAILY_ACCRUAL",
  initiationFeeModel: "FLAT_PCT",
  initiationFeePct: 0.15,
  initiationFeeMax: 100_000,
  monthlyServiceFee: 6_900,
  active: true,
}

function request(change: Record<string, unknown> = {}) {
  const body = {
    code: before.code,
    name: before.name,
    productType: before.productType,
    minAmount: before.minAmount / 100,
    maxAmount: before.maxAmount / 100,
    minTermDays: before.minTermDays,
    maxTermDays: before.maxTermDays,
    interestRatePm: before.interestRatePm * 100,
    interestModel: before.interestModel,
    initiationFeeModel: before.initiationFeeModel,
    initiationFeePct: before.initiationFeePct * 100,
    initiationFeeMax: before.initiationFeeMax / 100,
    monthlyServiceFee: before.monthlyServiceFee / 100,
    active: before.active,
    ...change,
  }
  return new NextRequest("http://localhost/api/products/loan/product-1", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

const personal = {
  code: "CUSTOM",
  name: "Custom Loan",
  productType: "PERSONAL",
  interestModel: "REDUCING_BALANCE",
  minTermDays: 30,
  maxTermDays: 90,
}
const custom = { ...before, ...personal }

const context = { params: Promise.resolve({ id: "product-1" }) }

describe("PUT /api/products/loan/[id] bounds validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    findUnique.mockResolvedValue(custom)
    update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...custom, ...data }),
    )
    queryRaw.mockResolvedValue([])
    auditCreate.mockResolvedValue({ id: "audit-1" })
    transaction.mockImplementation(
      (callback: (tx: unknown) => unknown) => callback({
        $queryRaw: queryRaw,
        loanProduct: { findUnique, update },
        loanApplication: { count },
        auditLog: { create: auditCreate },
      }),
    )
  })

  async function expectRejected(change: Record<string, unknown>, field: string) {
    const response = await PUT(request({ ...personal, ...change }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      invalidFields: expect.arrayContaining([field]),
    }))
    expect(transaction).not.toHaveBeenCalled()
  }

  it("rejects a minimum amount above the maximum before opening a transaction", async () => {
    await expectRejected({ minAmount: 9_000, maxAmount: 100 }, "maxAmount")
  })

  it("rejects a negative amount", async () => {
    await expectRejected({ minAmount: -5 }, "minAmount")
  })

  it("rejects a string amount", async () => {
    await expectRejected({ maxAmount: "10000" }, "maxAmount")
  })

  it("rejects a zero minimum term", async () => {
    await expectRejected({ minTermDays: 0 }, "minTermDays")
  })

  it("rejects a minimum term above the maximum on a non-MICRO30 product", async () => {
    await expectRejected({ minTermDays: 120, maxTermDays: 60 }, "maxTermDays")
  })

  it("still lets a valid non-MICRO30 update reach the transaction", async () => {
    const response = await PUT(request({ ...personal, name: "Renamed Loan" }), context)

    expect(response.status).toBe(200)
    expect(transaction).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ minAmount: 50_000, maxAmount: 1_000_000, maxTermDays: 90 }),
    }))
  })
})
