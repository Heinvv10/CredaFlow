// app/api/insurance/eligibility-rules/[id]/route.test.ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { findFirstRule, updateRule, deleteRule, logAudit } = vi.hoisted(() => ({
  findFirstRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceEligibilityRule: { findFirst: findFirstRule, update: updateRule, delete: deleteRule },
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

import { PATCH, DELETE } from "./route"

const ctx = { params: Promise.resolve({ id: "rule-1" }) }
const url = "http://localhost/api/insurance/eligibility-rules/rule-1"

const EXISTING = {
  id: "rule-1",
  tenantId: "tenant-1",
  productId: "product-1",
  lifeScope: "MAIN_MEMBER",
  ruleType: "MAX_ENTRY_AGE",
  numericValue: 65,
  active: true,
}

function patchReq(body: unknown) {
  return new NextRequest(url, {
    method: "PATCH",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("PATCH /api/insurance/eligibility-rules/[id]", () => {
  it("404s a rule belonging to another tenant", async () => {
    findFirstRule.mockResolvedValue(null)

    const res = await PATCH(patchReq({ numericValue: 70 }), ctx)

    expect(res.status).toBe(404)
    expect(findFirstRule.mock.calls[0][0].where).toEqual({ id: "rule-1", tenantId: "tenant-1" })
    expect(updateRule).not.toHaveBeenCalled()
  })

  it("returns 422 for an unparseable body", async () => {
    findFirstRule.mockResolvedValue({ ...EXISTING })

    const res = await PATCH(patchReq("{nope"), ctx)

    expect(res.status).toBe(422)
    expect(updateRule).not.toHaveBeenCalled()
  })

  it.each([
    ["negative numericValue", { numericValue: -1 }],
    ["non-numeric numericValue", { numericValue: "70" }],
    ["non-boolean active", { active: "yes" }],
  ])("rejects %s with 422", async (_label, override) => {
    findFirstRule.mockResolvedValue({ ...EXISTING })

    const res = await PATCH(patchReq(override), ctx)

    expect(res.status).toBe(422)
    expect(updateRule).not.toHaveBeenCalled()
  })

  it("never lets a PATCH move a rule to a different product or rule type", async () => {
    findFirstRule.mockResolvedValue({ ...EXISTING })
    updateRule.mockResolvedValue({ ...EXISTING })

    await PATCH(patchReq({ productId: "product-other", ruleType: "MIN_COVER", numericValue: 70 }), ctx)

    const data = updateRule.mock.calls[0][0].data
    expect(data.productId).toBeUndefined()
    expect(data.ruleType).toBeUndefined()
    expect(data.numericValue).toBe(70)
  })

  it("updates the rule and audits it", async () => {
    findFirstRule.mockResolvedValue({ ...EXISTING })
    updateRule.mockResolvedValue({ ...EXISTING, numericValue: 70 })

    const res = await PATCH(patchReq({ numericValue: 70, active: false }), ctx)

    expect(res.status).toBe(200)
    expect(updateRule.mock.calls[0][0]).toMatchObject({
      where: { id: "rule-1" },
      data: { numericValue: 70, active: false },
    })
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "INSURANCE_ELIGIBILITY_RULE_UPDATED",
        entity: "InsuranceEligibilityRule",
        entityId: "rule-1",
      })
    )
  })

  // A body with no writable key is not an edit. Writing it anyway bumps
  // updatedAt and files an audit row reading `newValue: {}` — evidence of a
  // change to an insurer acceptance term that never happened. The sibling
  // rate-table PATCH already refuses this; these two must agree.
  it.each([
    ["an empty object", {}],
    ["only the identity key productId", { productId: "product-other" }],
    ["only identity keys", { productId: "product-other", ruleType: "MIN_COVER", lifeScope: "SPOUSE" }],
  ])("refuses %s with 422 rather than filing an empty change", async (_label, body) => {
    findFirstRule.mockResolvedValue({ ...EXISTING })

    const res = await PATCH(patchReq(body), ctx)

    expect(res.status).toBe(422)
    expect(updateRule).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  // The audit trail is evidence of what the DATABASE holds, not of what the
  // caller asked for. Logging the parsed input hides a write the DB altered or
  // rejected in part.
  it("audits the persisted row, not the parsed request input", async () => {
    findFirstRule.mockResolvedValue({ ...EXISTING })
    // The DB is the authority: it returns the stored Decimal and the columns
    // the request never mentioned.
    updateRule.mockResolvedValue({
      ...EXISTING,
      numericValue: 70,
      active: false,
      updatedAt: new Date("2026-08-16T00:00:00Z"),
    })

    await PATCH(patchReq({ numericValue: 70, active: false }), ctx)

    const logged = logAudit.mock.calls[0][0]
    // `data` (the input) has exactly two keys; the persisted row has more.
    expect(logged.newValue).toMatchObject({
      id: "rule-1",
      productId: "product-1",
      ruleType: "MAX_ENTRY_AGE",
      numericValue: 70,
      active: false,
    })
  })
})

describe("DELETE /api/insurance/eligibility-rules/[id]", () => {
  it("404s a rule belonging to another tenant", async () => {
    findFirstRule.mockResolvedValue(null)

    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx)

    expect(res.status).toBe(404)
    expect(deleteRule).not.toHaveBeenCalled()
  })

  it("deletes the rule and audits it", async () => {
    findFirstRule.mockResolvedValue({ ...EXISTING })
    deleteRule.mockResolvedValue({ id: "rule-1" })

    const res = await DELETE(new NextRequest(url, { method: "DELETE" }), ctx)

    expect(res.status).toBe(200)
    expect(deleteRule).toHaveBeenCalledWith({ where: { id: "rule-1" } })
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_ELIGIBILITY_RULE_DELETED",
        entity: "InsuranceEligibilityRule",
        entityId: "rule-1",
      })
    )
  })
})

describe("PATCH /api/insurance/eligibility-rules/[id] — non-object bodies", () => {
  it.each([
    ["null", null],
    ["an array", []],
    ["a scalar", 42],
  ])("returns 422 for a body that is %s", async (_label, body) => {
    findFirstRule.mockResolvedValue({ ...EXISTING })

    const res = await PATCH(patchReq(body), ctx)

    expect(res.status).toBe(422)
    expect(updateRule).not.toHaveBeenCalled()
  })

  it.each([
    ["a numericValue past Decimal(14,2)", { numericValue: 1e30 }],
    ["a numericValue carrying more than 2 decimals", { numericValue: 64.555 }],
    ["an over-long textValue", { textValue: "x".repeat(1001) }],
  ])("rejects %s with 422", async (_label, override) => {
    findFirstRule.mockResolvedValue({ ...EXISTING })

    const res = await PATCH(patchReq(override), ctx)

    expect(res.status).toBe(422)
    expect(updateRule).not.toHaveBeenCalled()
  })
})
