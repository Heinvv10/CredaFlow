import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const claimUpdateMock = vi.fn()
const claimFindFirstMock = vi.fn()
const claimUpdateManyMock = vi.fn()
const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceClaim: {
      update: (a: unknown) => claimUpdateMock(a),
      findFirst: (a: unknown) => claimFindFirstMock(a),
      updateMany: (a: unknown) => claimUpdateManyMock(a),
    },
  },
}))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...a: unknown[]) => requireApiRoleMock(...a),
}))
// featureIms ON — the IMS API gate (requireImsEnabled) must be a no-op
// for every behaviour asserted below. The gate reads the LIVE TenantConfig
// row (uncached, so the kill switch has no fuse), so it is stubbed on the
// prisma mock rather than on getTenantConfig.
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))
// Preserve the real AuditAction enum; spy only on logAudit.
vi.mock("@/lib/audit", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, logAudit: (...a: unknown[]) => logAuditMock(...a) }
})

import { PATCH } from "./route"

function buildReq(body: object): NextRequest {
  return new NextRequest("https://app.acme-lending.example/api/insurance/claims/claim_1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
const ctx = { params: Promise.resolve({ id: "claim_1" }) }

beforeEach(() => {
  vi.resetAllMocks()
  requireApiRoleMock.mockResolvedValue({
    user: { id: "u_1", email: "officer@example.test", name: "Officer", role: "INSURANCE_OFFICER" },
  })
  withTenantContextMock.mockImplementation(async (_req, cb) => cb({ id: "tenant_acme" }))
  claimUpdateMock.mockResolvedValue({ id: "claim_1", status: "APPROVED" })
  // A R10 000 claim on a R20 000 policy (Decimal columns: toCents reads them exactly).
  claimFindFirstMock.mockResolvedValue({
    id: "claim_1", status: "SUBMITTED", claimAmount: "10000.00",
    policy: { sumAssured: "20000.00" },
  })
  claimUpdateManyMock.mockResolvedValue({ count: 1 })
})

describe("PATCH /api/insurance/claims/[id] — audit trail", () => {
  it("approve: 200 + logAudit INSURANCE_CLAIM_APPROVED with the amount", async () => {
    const res = await PATCH(buildReq({ action: "approve", approvedAmount: 5000 }), ctx)
    expect(res.status).toBe(200)
    expect(logAuditMock).toHaveBeenCalledTimes(1)
    const arg = logAuditMock.mock.calls[0][0]
    expect(arg).toMatchObject({
      action: "INSURANCE_CLAIM_APPROVED",
      entity: "InsuranceClaim",
      entityId: "claim_1",
      userId: "u_1",
      userEmail: "officer@example.test",
    })
    expect(arg.newValue).toMatchObject({ status: "APPROVED", approvedAmount: 5000 })
  })

  it("reject: 200 + logAudit INSURANCE_CLAIM_REJECTED with the reason", async () => {
    claimUpdateMock.mockResolvedValue({ id: "claim_1", status: "REJECTED" })
    const res = await PATCH(buildReq({ action: "reject", rejectionReason: "Fraudulent" }), ctx)
    expect(res.status).toBe(200)
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({
      action: "INSURANCE_CLAIM_REJECTED",
      newValue: { status: "REJECTED", rejectionReason: "Fraudulent" },
    })
  })

  it("generic status update: 200 + logAudit INSURANCE_CLAIM_UPDATED", async () => {
    const res = await PATCH(buildReq({ status: "UNDER_REVIEW", notes: "assigned" }), ctx)
    expect(res.status).toBe(200)
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({
      action: "INSURANCE_CLAIM_UPDATED",
      newValue: { status: "UNDER_REVIEW", notes: "assigned" },
    })
  })

  it("approve without approvedAmount: 400 + NO audit, NO update", async () => {
    const res = await PATCH(buildReq({ action: "approve" }), ctx)
    expect(res.status).toBe(400)
    expect(logAuditMock).not.toHaveBeenCalled()
    expect(claimUpdateMock).not.toHaveBeenCalled()
    expect(claimUpdateManyMock).not.toHaveBeenCalled()
  })

  it("reject without rejectionReason: 400 + NO audit, NO update", async () => {
    const res = await PATCH(buildReq({ action: "reject" }), ctx)
    expect(res.status).toBe(400)
    expect(logAuditMock).not.toHaveBeenCalled()
    expect(claimUpdateMock).not.toHaveBeenCalled()
  })

  it("unauthorized (guard.error): no update, no audit", async () => {
    requireApiRoleMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })
    const res = await PATCH(buildReq({ action: "approve", approvedAmount: 5000 }), ctx)
    expect(res.status).toBe(403)
    expect(claimUpdateMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})

// Fair Score audit (2026-10-16): "Claim approval accepted Approved Amount
// R1,000,010,000.00 on a R10,000 claim". The insurer cannot pay more than was
// claimed, nor more than the cover.
describe("PATCH /api/insurance/claims/[id] — the approved amount is bounded", () => {
  it("refuses more than the amount claimed, writing and auditing nothing", async () => {
    const res = await PATCH(buildReq({ action: "approve", approvedAmount: 1_000_010_000 }), ctx)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/claimed/)
    expect(claimUpdateMock).not.toHaveBeenCalled()
    expect(claimUpdateManyMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("refuses more than the policy's sum assured even when the claim asks for more", async () => {
    claimFindFirstMock.mockResolvedValue({
      id: "claim_1", status: "SUBMITTED", claimAmount: "50000.00",
      policy: { sumAssured: "20000.00" },
    })
    const res = await PATCH(buildReq({ action: "approve", approvedAmount: 20_000.01 }), ctx)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/sum assured/)
    expect(claimUpdateManyMock).not.toHaveBeenCalled()
  })

  it("refuses an amount that is not a positive rand figure", async () => {
    for (const approvedAmount of [-5, 0, "5000", 10.001]) {
      const res = await PATCH(buildReq({ action: "approve", approvedAmount }), ctx)
      expect(res.status).toBe(400)
    }
    expect(claimUpdateManyMock).not.toHaveBeenCalled()
  })

  it("accepts exactly the claimed amount, and re-asserts both bounds in the write", async () => {
    const res = await PATCH(buildReq({ action: "approve", approvedAmount: 10_000 }), ctx)
    expect(res.status).toBe(200)
    expect(claimUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: "claim_1", tenantId: "tenant_acme",
        claimAmount: { gte: 10_000 }, policy: { sumAssured: { gte: 10_000 } },
      }),
      data: expect.objectContaining({ status: "APPROVED", approvedAmount: 10_000 }),
    }))
    expect(logAuditMock).toHaveBeenCalledTimes(1)
  })

  it("404s a claim of another tenant", async () => {
    claimFindFirstMock.mockResolvedValue(null)
    const res = await PATCH(buildReq({ action: "approve", approvedAmount: 5000 }), ctx)
    expect(res.status).toBe(404)
    expect(claimUpdateManyMock).not.toHaveBeenCalled()
  })

  it("409s when the claim changed between the read and the write", async () => {
    claimUpdateManyMock.mockResolvedValue({ count: 0 })
    const res = await PATCH(buildReq({ action: "approve", approvedAmount: 5000 }), ctx)
    expect(res.status).toBe(409)
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})

// The generic update took any `status`, so { status: "APPROVED" } approved a
// claim with no amount and past every bound above.
describe("PATCH /api/insurance/claims/[id] — status APPROVED is an approval", () => {
  it("refuses APPROVED without an amount, writing nothing", async () => {
    const res = await PATCH(buildReq({ status: "APPROVED", notes: "approved by phone" }), ctx)
    expect(res.status).toBe(400)
    expect(claimUpdateMock).not.toHaveBeenCalled()
    expect(claimUpdateManyMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("holds APPROVED to the same bounds as the decision", async () => {
    const res = await PATCH(buildReq({ status: "APPROVED", approvedAmount: 1_000_010_000 }), ctx)
    expect(res.status).toBe(422)
    expect(claimUpdateMock).not.toHaveBeenCalled()
    expect(claimUpdateManyMock).not.toHaveBeenCalled()
  })

  it("records APPROVED with a bounded amount as an approval", async () => {
    const res = await PATCH(buildReq({ status: "APPROVED", approvedAmount: 5000 }), ctx)
    expect(res.status).toBe(200)
    expect(claimUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "APPROVED", approvedAmount: 5000 }),
    }))
    expect(logAuditMock.mock.calls[0][0]).toMatchObject({ action: "INSURANCE_CLAIM_APPROVED" })
  })
})
