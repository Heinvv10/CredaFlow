import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { requireApiRole, findUnique, count, versionCount, propose } = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  findUnique: vi.fn(),
  count: vi.fn(),
  versionCount: vi.fn(),
  propose: vi.fn(),
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
    loanProduct: { findUnique },
    loanApplication: { count },
    productVersion: { count: versionCount },
    // Approved SARB repo 7%: the NCA unsecured cap is 28% a year (2.33% a month).
    referenceRate: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({ effectiveDate: new Date("2026-01-01T00:00:00Z"), rate: { toNumber: () => 0.07 } })),
    },
  },
}))
vi.mock("@/lib/product-config/propose", () => ({ proposeProductChange: propose }))
vi.mock("@/lib/maker-checker/http", () => ({ presentChangeRequest: (row: unknown) => row, changeRequestErrorResponse: (error: unknown) => { throw error } }))

import { PUT } from "./route"

const before = {
  id: "product-1",
  tenantId: "tenant-1",
  code: "MICRO30",
  name: "30-Day Micro Loan",
  productType: "MICRO",
  minAmount: 50_000,
  // R2,000 for 30 days, as seeded: a short-term credit transaction, so 5% a
  // month is within the NCA cap (lib/loan/nca-interest-cap.ts).
  maxAmount: 200_000,
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
    reason: "Quarterly review of the product",
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
  interestRatePm: 2, // percent a month, as the form sends it: 24% a year
  minTermDays: 30,
  maxTermDays: 90,
}
const custom = { ...before, ...personal }

const context = { params: Promise.resolve({ id: "product-1" }) }
/** The payload a route proposed: nothing is written until a second person approves it. */
const proposed = () => propose.mock.calls.at(-1)![3] as { product: Record<string, unknown>; reason: string; action: string }

beforeEach(() => {
  propose.mockResolvedValue({ id: "cr-1" })
  versionCount.mockResolvedValue(0)
})

describe("PUT /api/products/loan/[id] bounds validation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    findUnique.mockResolvedValue(custom)
  })

  async function expectRejected(change: Record<string, unknown>, field: string) {
    const response = await PUT(request({ ...personal, ...change }), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      invalidFields: expect.arrayContaining([field]),
    }))
    expect(propose).not.toHaveBeenCalled()
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

  it("still lets a valid non-MICRO30 update through to a proposal", async () => {
    const response = await PUT(request({ ...personal, name: "Renamed Loan" }), context)

    expect(response.status).toBe(202)
    expect(proposed().product).toEqual(expect.objectContaining({ minAmount: 50_000, maxAmount: 200_000, maxTermDays: 90 }))
  })
})
