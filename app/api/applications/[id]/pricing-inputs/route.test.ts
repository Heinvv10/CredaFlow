import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const requireApiRole = vi.hoisted(() => vi.fn())
const canDo = vi.hoisted(() => vi.fn())
const findApplication = vi.hoisted(() => vi.fn())
const ruleFindMany = vi.hoisted(() => vi.fn())
const queryRaw = vi.hoisted(() => vi.fn())
const inputFindFirst = vi.hoisted(() => vi.fn())
const inputUpsert = vi.hoisted(() => vi.fn())
const logAuditStrict = vi.hoisted(() => vi.fn())
const approvalTermsFor = vi.hoisted(() => vi.fn())

vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/permissions", () => ({ canDo }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, cb: (t: { id: string }) => unknown) => cb({ id: "t1" }) }))
vi.mock("@/lib/audit", () => ({ AuditAction: new Proxy({}, { get: (_t, k) => String(k) }), logAuditStrict }))
vi.mock("@/lib/product-engine/approval-terms", () => ({ approvalTermsFor }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findFirst: findApplication },
    productPricingRule: { findMany: ruleFindMany },
    $transaction: (cb: (tx: unknown) => unknown) => cb({ $queryRaw: queryRaw, applicationPricingInput: { findFirst: inputFindFirst, upsert: inputUpsert } }),
  },
}))

import { GET, PUT } from "./route"

const ctx = { params: Promise.resolve({ id: "app-1" }) }
const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/applications/app-1/pricing-inputs", { method: "PUT", body: JSON.stringify(body) }), ctx)

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRole.mockResolvedValue({ user: { id: "officer-1", email: "o@example.test", role: "CREDIT_OFFICER" } })
  canDo.mockReturnValue(true)
  ruleFindMany.mockResolvedValue([{ segment: "SALARIED" }, { segment: "SELF_EMPLOYED" }])
  queryRaw.mockResolvedValue([{ status: "UNDER_REVIEW" }])
  inputFindFirst.mockResolvedValue(null)
  inputUpsert.mockResolvedValue({})
  logAuditStrict.mockResolvedValue(undefined)
})

describe("PUT /api/applications/[id]/pricing-inputs", () => {
  it("saves a configured segment and a fixed channel, audited, under the application's row lock", async () => {
    const res = await put({ segment: "SALARIED", channel: "BRANCH", campaignCode: "SPRING27" })
    expect(res.status).toBe(200)
    expect((queryRaw.mock.calls[0]![0] as string[]).join("?")).toMatch(/FROM "LoanApplication" WHERE .*FOR UPDATE/)
    expect(inputUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: { segment: "SALARIED", channel: "BRANCH", campaignCode: "SPRING27", updatedById: "officer-1" } }))
    expect(logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "APPLICATION_PRICING_INPUT_SET", newValue: { segment: "SALARIED", channel: "BRANCH", campaignCode: "SPRING27" } }), expect.anything())
  })

  it("refuses a segment the lender has not configured: the segments are the ones its approved rules name", async () => {
    const res = await put({ segment: "VIP", channel: null, campaignCode: null })
    expect(res.status).toBe(422)
    expect(inputUpsert).not.toHaveBeenCalled()
  })

  it("refuses a channel that is not one of the fixed channels", async () => {
    const res = await put({ segment: null, channel: "MOBILE", campaignCode: null })
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("DIGITAL") })
    expect(inputUpsert).not.toHaveBeenCalled()
  })

  it("refuses once the application is decided: the status is read under the lock, not before it", async () => {
    queryRaw.mockResolvedValue([{ status: "APPROVED" }])
    const res = await put({ segment: "SALARIED", channel: null, campaignCode: null })
    expect(res.status).toBe(409)
    expect(inputUpsert).not.toHaveBeenCalled()
    expect(logAuditStrict).not.toHaveBeenCalled()
  })

  it("answers 404 for an application that is not this lender's", async () => {
    queryRaw.mockResolvedValue([])
    expect((await put({ segment: null, channel: null, campaignCode: null })).status).toBe(404)
  })

  it("is for those who may set pricing inputs", async () => {
    canDo.mockReturnValue(false)
    expect((await put({ segment: null, channel: null, campaignCode: null })).status).toBe(403)
  })
})

describe("GET /api/applications/[id]/pricing-inputs", () => {
  it("answers the inputs, the price they give, and the values a person may choose", async () => {
    findApplication.mockResolvedValue({
      id: "app-1", status: "UNDER_REVIEW", productId: "p1", appliedTermDays: 90, riskGradeRank: 1, product: {},
      pricingInput: { segment: "SALARIED", channel: "DIGITAL", campaignCode: null },
    })
    approvalTermsFor.mockResolvedValue({ interestRatePm: 0.02, versioned: { baseRatePm: 0.03, version: 4, pricingRuleName: "Best grades" }, repayment: null })
    const res = await GET(new NextRequest("http://localhost/api/applications/app-1/pricing-inputs"), ctx)
    expect(await res.json()).toMatchObject({
      inputs: { segment: "SALARIED", channel: "DIGITAL", campaignCode: null }, open: true,
      options: { segments: ["SALARIED", "SELF_EMPLOYED"], channels: ["DIGITAL", "BRANCH", "API", "AGENT"] },
      price: { interestRatePm: 0.02, baseRatePm: 0.03, productVersion: 4, rule: "Best grades" },
    })
  })
})
