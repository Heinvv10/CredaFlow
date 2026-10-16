import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { requireApiRole, create, repo } = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  create: vi.fn(),
  // The tenant's approved SARB repo rate (Asset finance → Reference rates).
  repo: { rate: 0.07 as number | null },
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
    referenceRate: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => repo.rate === null
        ? null
        : { effectiveDate: new Date("2026-01-01T00:00:00Z"), rate: { toNumber: () => repo.rate } }),
    },
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
    // 24% a year: inside the NCA unsecured cap of repo 7% + 21%.
    interestRatePm: 2,
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

  it("rejects booleans, arrays and strings in the bound fields", async () => {
    const response = await POST(request({
      minAmount: true, maxAmount: [5000], minTermDays: true, maxTermDays: "0x1e",
    }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      invalidFields: ["minAmount", "maxAmount", "minTermDays", "maxTermDays"],
    }))
    expect(create).not.toHaveBeenCalled()
  })

  it("rejects an amount beyond the int4 cents column", async () => {
    const response = await POST(request({ maxAmount: 30_000_000 }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      invalidFields: ["maxAmount"],
    }))
    expect(create).not.toHaveBeenCalled()
  })

  it("rejects a minimum term above the maximum", async () => {
    const response = await POST(request({ minTermDays: 120, maxTermDays: 60 }))

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      invalidFields: ["maxTermDays"],
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

describe("POST /api/products/loan NON_NCA arrears terms", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRole.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
    create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "product-9", ...data }))
  })

  it("stores the margin as an annual decimal and the fee in cents", async () => {
    const response = await POST(request({ nonNcaDefaultInterestMargin: "0.02", nonNcaCollectionFeeCents: 25_000 }))
    expect(response.status).toBe(201)
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({ nonNcaDefaultInterestMargin: "0.02", nonNcaCollectionFeeCents: 25_000 }),
    })
  })

  it("leaves both out when not sent (a consumer product)", async () => {
    await POST(request())
    const data = create.mock.calls[0][0].data as Record<string, unknown>
    expect("nonNcaDefaultInterestMargin" in data).toBe(false)
    expect("nonNcaCollectionFeeCents" in data).toBe(false)
  })

  it("refuses a percentage where the decimal belongs, and a fractional fee, 422 without writing", async () => {
    const response = await POST(request({ nonNcaDefaultInterestMargin: "2", nonNcaCollectionFeeCents: 250.5 }))
    expect(response.status).toBe(422)
    expect((await response.json()).invalidFields).toEqual(["nonNcaDefaultInterestMargin", "nonNcaCollectionFeeCents"])
    expect(create).not.toHaveBeenCalled()
  })
})

describe("POST /api/products/loan NCA interest-rate cap (Regulation 42)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    repo.rate = 0.07
    requireApiRole.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
    create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "product-9", ...data }))
  })

  it("refuses an unsecured product above repo + 21% (the demo Personal Loan's 3% a month), without writing", async () => {
    const response = await POST(request({ interestRatePm: 3, maxAmount: 100_000, maxTermDays: 1_800 }))
    expect(response.status).toBe(422)
    const body = await response.json()
    expect(body.invalidFields).toEqual(["interestRatePm"])
    expect(body.error).toContain("exceeds the NCA maximum of 28.00%")
    expect(create).not.toHaveBeenCalled()
  })

  it("accepts an unsecured product exactly at the cap", async () => {
    const response = await POST(request({ interestRatePm: 28 / 12, maxAmount: 100_000, maxTermDays: 1_800 }))
    expect(response.status).toBe(201)
  })

  it("refuses an unsecured product when no repo rate is recorded", async () => {
    repo.rate = null
    const response = await POST(request())
    expect(response.status).toBe(422)
    expect((await response.json()).error).toContain("no approved repo rate is recorded")
    expect(create).not.toHaveBeenCalled()
  })

  it("holds a short-term product (≤ R8,000, ≤ 6 months) to 5% a month, with no repo rate needed", async () => {
    repo.rate = null
    const micro = { maxAmount: 2_000, minTermDays: 30, maxTermDays: 30, interestModel: "DAILY_ACCRUAL" }
    expect((await POST(request({ ...micro, interestRatePm: 5 }))).status).toBe(201)
    expect((await POST(request({ ...micro, interestRatePm: 5.5 }))).status).toBe(422)
  })
})
