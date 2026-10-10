// app/api/insurance/policies/[id]/route.test.ts
//
// Covers R-09 gap #1: PATCH on a STANDALONE policy must refuse changes to
// fields that appeared on the FAIS disclosure PDF the client acknowledged
// at bind. Other fields (risk info, renewalDate, status) remain editable.
import { afterEach, describe, expect, it, vi } from "vitest"
import { PATCH } from "./route"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const {
  findFirstPolicy,
  updatePolicy,
  logAudit,
} = vi.hoisted(() => ({
  findFirstPolicy: vi.fn(),
  updatePolicy: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insurancePolicy: {
      findFirst: findFirstPolicy,
      update: updatePolicy,
    },
  },
}))

// featureIms ON — the IMS API gate (requireImsEnabled) must be a no-op
// for every behaviour asserted below. The gate reads the LIVE TenantConfig
// row (uncached, so the kill switch has no fuse), so it is stubbed on the
// prisma mock rather than on getTenantConfig.
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

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/insurance/policies/policy-1", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const ctx = { params: Promise.resolve({ id: "policy-1" }) }

afterEach(() => {
  vi.clearAllMocks()
})

describe("PATCH /api/insurance/policies/[id] — FAIS lockdown", () => {
  it("rejects premiumAmount change on a STANDALONE policy with 422 + fais_locked audit", async () => {
    findFirstPolicy.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: new Date(),
      policySource: "STANDALONE",
    })

    const res = await PATCH(makeRequest({ premiumAmount: 9999 }), ctx)

    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toMatch(/cannot change FAIS-disclosed fields/i)
    expect(json.error).toMatch(/premiumAmount/)

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_PATCH_FAIS_LOCKED",
        entity: "InsurancePolicy",
        entityId: "policy-1",
        newValue: { attemptedFields: ["premiumAmount"] },
      })
    )
    expect(updatePolicy).not.toHaveBeenCalled()
  })

  it("rejects insurer + insurerId changes together with both names in the message", async () => {
    findFirstPolicy.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: new Date(),
      policySource: "STANDALONE",
    })

    const res = await PATCH(
      makeRequest({ insurer: "New Co", insurerId: "ins-2" }),
      ctx
    )

    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toMatch(/insurer/)
    expect(json.error).toMatch(/insurerId/)
    expect(updatePolicy).not.toHaveBeenCalled()
  })

  it("allows risk-field changes on a STANDALONE policy", async () => {
    findFirstPolicy.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: new Date(),
      policySource: "STANDALONE",
    })
    updatePolicy.mockResolvedValue({ id: "policy-1", vehicleRegNumber: "ABC 123 GP" })

    const res = await PATCH(makeRequest({ vehicleRegNumber: "ABC 123 GP" }), ctx)

    expect(res.status).toBe(200)
    expect(updatePolicy).toHaveBeenCalledOnce()
    expect(logAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: "INSURANCE_PATCH_FAIS_LOCKED" })
    )
  })

  const bundledCreditLife = {
    id: "policy-1",
    pprIssuedAt: new Date(),
    policySource: "BUNDLED_CREDIT_AGREEMENT",
    type: "CREDIT_LIFE",
    premiumAmount: new Prisma.Decimal("22.50"),
    renewalDate: new Date("2026-08-23T00:00:00.000Z"),
  }

  it.each([
    [{ premiumAmount: 9999 }, "premiumAmount"],
    [{ premiumAmount: "22.51" }, "premiumAmount"],
    [{ renewalDate: "2027-01-01" }, "renewalDate"],
    [{ premiumAmount: 1, renewalDate: "2027-01-01" }, "premiumAmount, renewalDate"],
  ])("refuses %j on a bundled credit-life policy with 422, writing nothing", async (body, fields) => {
    findFirstPolicy.mockResolvedValue(bundledCreditLife)

    const res = await PATCH(makeRequest(body), ctx)

    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.error).toMatch(/bundled credit-life/i)
    expect(json.error).toContain(`Locked: ${fields}`)
    expect(updatePolicy).not.toHaveBeenCalled()
  })

  it.each([
    [{ premiumAmount: 22.5 }],
    [{ premiumAmount: "22.50" }],
    [{ renewalDate: "2026-08-23T00:00:00.000Z" }],
    [{ renewalDate: "" }],
    [{ renewalDate: null }],
    [{ status: "LAPSED" }],
    [{ status: "LAPSED", premiumAmount: 22.5, renewalDate: "" }],
  ])("lets %j through on a bundled credit-life policy: nothing bound would change", async (body) => {
    findFirstPolicy.mockResolvedValue(bundledCreditLife)
    updatePolicy.mockResolvedValue({ id: "policy-1" })

    const res = await PATCH(makeRequest(body), ctx)

    expect(res.status).toBe(200)
    expect(updatePolicy).toHaveBeenCalledOnce()
  })

  it("preserves the pre-existing pprIssuedAt activation guard for status=ACTIVE", async () => {
    findFirstPolicy.mockResolvedValue({
      id: "policy-1",
      pprIssuedAt: null,
      policySource: "STANDALONE",
    })

    const res = await PATCH(makeRequest({ status: "ACTIVE" }), ctx)

    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/product disclosure must be issued/i)
  })
})
