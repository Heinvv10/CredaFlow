// app/api/insurance/commissions/route.test.ts
//
// The POST is a batch money event: it creates every advisor commission for a
// period in one call. CLAUDE.md requires a state-changing action to leave an
// audit row; without one there is no record of who ran the calculation, for
// which period, or how many rows it produced.
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { findManyPolicies, createCommission, logAudit } = vi.hoisted(() => ({
  findManyPolicies: vi.fn(),
  createCommission: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insurancePolicy: { findMany: findManyPolicies },
    advisorCommission: { create: createCommission },
  },
}))

vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "admin@acme-lending.example" },
  }),
}))

vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

import { POST } from "./route"

const url = "http://localhost/api/insurance/commissions"

function postReq(body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/insurance/commissions — audit trail", () => {
  it("audits the calculation run with the period and the counts it produced", async () => {
    findManyPolicies.mockResolvedValue([
      { id: "policy-1", advisorId: "advisor-1", premiumAmount: 100, commissionRate: 0.15 },
      { id: "policy-2", advisorId: "advisor-2", premiumAmount: 200, commissionRate: 0.15 },
    ])
    createCommission.mockResolvedValue({ id: "comm-1" })

    const res = await POST(postReq({ period: "2026-08" }))

    expect(res.status).toBe(201)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        userEmail: "admin@acme-lending.example",
        action: "INSURANCE_COMMISSIONS_CALCULATED",
        entity: "AdvisorCommission",
        newValue: expect.objectContaining({ period: "2026-08", created: 2, skipped: 0 }),
      })
    )
  })

  it("records the skipped count when a period was already calculated", async () => {
    findManyPolicies.mockResolvedValue([
      { id: "policy-1", advisorId: "advisor-1", premiumAmount: 100, commissionRate: 0.15 },
    ])
    // @@unique([advisorId, policyId, period]) — the row already exists.
    createCommission.mockRejectedValue(new Error("unique constraint"))

    await POST(postReq({ period: "2026-08" }))

    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        newValue: expect.objectContaining({ created: 0, skipped: 1 }),
      })
    )
  })
})
