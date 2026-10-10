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

import { DELETE, PUT } from "./route"

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

const context = { params: Promise.resolve({ id: "product-1" }) }

describe("PUT /api/products/loan/[id] MICRO30 guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    findUnique.mockResolvedValue(before)
    update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...before, ...data }),
    )
    count.mockResolvedValue(0)
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

  it.each([
    ["MICRO30", before],
    ["PERSONAL", { ...before, code: "PERSONAL", name: "Personal Loan", productType: "PERSONAL", interestModel: "REDUCING_BALANCE", minTermDays: 30, maxTermDays: 90 }],
    ["POFUND", { ...before, code: "POFUND", name: "PO Funding", productType: "PO_FUNDING", interestModel: "REDUCING_BALANCE", minTermDays: 30, maxTermDays: 90 }],
  ] as const)("refuses to rename the portal-stable code %s", async (_code, row) => {
    // The portal apply pages resolve products by these exact codes; a rename
    // silently 404s that journey. All three are stable, not just MICRO30.
    findUnique.mockResolvedValue(row)

    const response = await PUT(request({
      code: "RENAMED",
      name: row.name,
      productType: row.productType,
      interestModel: row.interestModel,
      minTermDays: row.minTermDays,
      maxTermDays: row.maxTermDays,
    }), context)

    expect(response.status).toBe(422)
    const { error } = await response.json()
    // The refusal must name the ACTUAL code, not always MICRO30.
    expect(error).toContain(_code)
    expect(error).toMatch(/stable product code/)
    expect(update).not.toHaveBeenCalled()
  })

  it("pins a case/whitespace variant of a stable code back to its canonical value", async () => {
    // " micro30 " passes the normalised comparison but must never be WRITTEN
    // raw — the portal's findFirst({ code }) is an exact text match.
    const response = await PUT(request({ code: " micro30 " }), context)

    expect(response.status).toBe(200)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ code: "MICRO30" }),
    }))
  })

  it("rejects flat/R0 pricing before mutation", async () => {
    const response = await PUT(request({
      interestModel: "FLAT",
      monthlyServiceFee: 0,
    }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      invalidFields: expect.arrayContaining([
        "interestModel",
        "monthlyServiceFee",
      ]),
    }))
    expect(update).not.toHaveBeenCalled()
  })

  it("blocks a decision-bearing edit while applications are in flight", async () => {
    count.mockResolvedValue(2)
    const response = await PUT(request({ maxAmount: 9_000 }), context)

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      inFlightApplications: 2,
    }))
    expect(count).toHaveBeenCalledWith({
      where: {
        tenantId: "tenant-1",
        productId: "product-1",
        status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED"] },
      },
    })
    expect(update).not.toHaveBeenCalled()
  })

  it("allows a non-decision display-name edit", async () => {
    const response = await PUT(request({ name: "Short-term Loan" }), context)

    expect(response.status).toBe(200)
    expect(count).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        name: "Short-term Loan",
        interestModel: "DAILY_ACCRUAL",
        monthlyServiceFee: 6_900,
      }),
    }))
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "LOAN_PRODUCT_UPDATED",
        entityId: "product-1",
      }),
    })
  })
})

describe("DELETE /api/products/loan/[id] MICRO30 guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    findUnique.mockResolvedValue(before)
    update.mockResolvedValue({ ...before, active: false })
    count.mockResolvedValue(0)
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

  it("blocks deactivation while applications depend on the MICRO30 contract", async () => {
    count.mockResolvedValue(11)

    const response = await DELETE(
      new NextRequest("http://localhost/api/products/loan/product-1", {
        method: "DELETE",
      }),
      context,
    )

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual(expect.objectContaining({
      inFlightApplications: 11,
    }))
    expect(update).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("writes deactivation and its audit evidence in the same transaction", async () => {
    const response = await DELETE(
      new NextRequest("http://localhost/api/products/loan/product-1", {
        method: "DELETE",
      }),
      context,
    )

    expect(response.status).toBe(200)
    expect(transaction).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith({
      where: { id: "product-1", tenantId: "tenant-1" },
      data: { active: false },
    })
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "LOAN_PRODUCT_DEACTIVATED",
        entityId: "product-1",
        oldValue: { active: true },
        newValue: { active: false },
      }),
    })
  })

  it("does not return success when mandatory deactivation audit evidence fails", async () => {
    auditCreate.mockRejectedValue(new Error("audit unavailable"))

    await expect(DELETE(
      new NextRequest("http://localhost/api/products/loan/product-1", {
        method: "DELETE",
      }),
      context,
    )).rejects.toThrow("audit unavailable")
  })
})
