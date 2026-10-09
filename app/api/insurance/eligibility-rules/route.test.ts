// app/api/insurance/eligibility-rules/route.test.ts
//
// These rows are the INSURER's acceptance terms captured as data. Nothing here
// decides anything — but a mistyped rule silently changes who we may sell to,
// so the input is validated and every write is audited.
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const { findManyRules, createRule, findFirstProduct, logAudit } = vi.hoisted(() => ({
  findManyRules: vi.fn().mockResolvedValue([]),
  createRule: vi.fn(),
  findFirstProduct: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceProduct: { findFirst: findFirstProduct },
    insuranceEligibilityRule: { findMany: findManyRules, create: createRule },
  },
}))

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "officer@acme-lending.example" },
  }),
}))

vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

import { GET, POST } from "./route"

const url = "http://localhost/api/insurance/eligibility-rules"

const VALID = {
  productId: "product-1",
  lifeScope: "MAIN_MEMBER",
  ruleType: "MAX_ENTRY_AGE",
  numericValue: 65,
}

function postReq(body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  vi.clearAllMocks()
  findManyRules.mockResolvedValue([])
  createRule.mockResolvedValue({ id: "rule-1" })
})

describe("GET /api/insurance/eligibility-rules", () => {
  it("scopes the list to the caller's tenant", async () => {
    const res = await GET(new NextRequest(url))

    expect(res.status).toBe(200)
    expect(findManyRules.mock.calls[0][0].where).toEqual({ tenantId: "tenant-1" })
  })

  it("filters by productId when supplied", async () => {
    await GET(new NextRequest(`${url}?productId=product-9`))

    expect(findManyRules.mock.calls[0][0].where).toEqual({
      tenantId: "tenant-1",
      productId: "product-9",
    })
  })
})

describe("POST /api/insurance/eligibility-rules", () => {
  it("returns 422 for an unparseable body", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })

    const res = await POST(postReq("{nope"))

    expect(res.status).toBe(422)
    expect(createRule).not.toHaveBeenCalled()
  })

  it("404s a product belonging to another tenant rather than leaking it", async () => {
    findFirstProduct.mockResolvedValue(null)

    const res = await POST(postReq(VALID))

    expect(res.status).toBe(404)
    expect(createRule).not.toHaveBeenCalled()
    expect(findFirstProduct.mock.calls[0][0].where).toMatchObject({
      id: "product-1",
      tenantId: "tenant-1",
    })
  })

  it.each([
    ["missing productId", { productId: undefined }],
    ["unknown ruleType", { ruleType: "VIBES" }],
    ["missing ruleType", { ruleType: undefined }],
    ["unknown lifeScope", { lifeScope: "PET" }],
    ["missing numericValue", { numericValue: undefined }],
    ["negative numericValue", { numericValue: -1 }],
    ["non-numeric numericValue", { numericValue: "65" }],
  ])("rejects %s with 422", async (_label, override) => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })

    const res = await POST(postReq({ ...VALID, ...override }))

    expect(res.status).toBe(422)
    expect(createRule).not.toHaveBeenCalled()
  })

  it("defaults lifeScope to ALL_LIVES", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })

    await POST(postReq({ ...VALID, lifeScope: undefined }))

    expect(createRule.mock.calls[0][0].data).toMatchObject({ lifeScope: "ALL_LIVES" })
  })

  it("creates the rule tenant-scoped and audits it", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    createRule.mockResolvedValue({ id: "rule-7" })

    const res = await POST(postReq(VALID))

    expect(res.status).toBe(200)
    expect(createRule.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-1",
      productId: "product-1",
      lifeScope: "MAIN_MEMBER",
      ruleType: "MAX_ENTRY_AGE",
      numericValue: 65,
    })
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "INSURANCE_ELIGIBILITY_RULE_CREATED",
        entity: "InsuranceEligibilityRule",
        entityId: "rule-7",
      })
    )
  })

  it("409s a duplicate rule for the same product, scope and type", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    createRule.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "5",
        meta: { target: ["tenantId", "productId", "lifeScope", "ruleType"] },
      })
    )

    const res = await POST(postReq(VALID))

    expect(res.status).toBe(409)
  })
})

describe("POST /api/insurance/eligibility-rules — non-object bodies", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a scalar", 42],
  ])("returns 422 for a body that is %s", async (_label, body) => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })

    const res = await POST(postReq(body))

    expect(res.status).toBe(422)
    expect(createRule).not.toHaveBeenCalled()
  })
})

describe("POST /api/insurance/eligibility-rules — the `active` flag", () => {
  it.each([
    ["the string \"true\"", "true"],
    ["the string \"false\"", "false"],
    ["a number", 1],
    ["null", null],
  ])("refuses %s rather than coercing it to false", async (_label, active) => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })

    const res = await POST(postReq({ ...VALID, active }))

    // `body.active === true` used to turn every one of these into an INACTIVE
    // rule — an insurer term captured, saved, and silently not in force.
    expect(res.status).toBe(422)
    expect(createRule).not.toHaveBeenCalled()
  })

  it.each([
    ["true", true],
    ["false", false],
  ])("accepts the boolean %s and audits it", async (_label, active) => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })
    createRule.mockResolvedValue({ id: "rule-7", active })

    const res = await POST(postReq({ ...VALID, active }))

    expect(res.status).toBe(200)
    expect(createRule.mock.calls[0][0].data).toMatchObject({ active })
    // Whether a captured term is in force has to be visible in the audit row,
    // or the log cannot explain why screening ignored it.
    expect(logAudit.mock.calls[0][0].newValue).toMatchObject({ active })
  })

  it("defaults to active when the caller omits the flag", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })

    await POST(postReq(VALID))

    expect(createRule.mock.calls[0][0].data).toMatchObject({ active: true })
  })
})

describe("POST /api/insurance/eligibility-rules — value bounds", () => {
  it.each([
    ["a numericValue past Decimal(14,2)", { numericValue: 1e30 }],
    ["a numericValue carrying more than 2 decimals", { numericValue: 64.555 }],
    ["a textValue longer than the column is meant to hold", { textValue: "x".repeat(1001) }],
  ])("rejects %s with 422", async (_label, override) => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })

    const res = await POST(postReq({ ...VALID, ...override }))

    expect(res.status).toBe(422)
    expect(createRule).not.toHaveBeenCalled()
  })

  it("trims a textValue before storing it", async () => {
    findFirstProduct.mockResolvedValue({ id: "product-1" })

    await POST(postReq({ ...VALID, textValue: "  excludes suicide in year 1  " }))

    expect(createRule.mock.calls[0][0].data).toMatchObject({
      textValue: "excludes suicide in year 1",
    })
  })
})
