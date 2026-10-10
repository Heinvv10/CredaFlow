import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const claimUpdateMock = vi.fn()
const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const logAuditMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insuranceClaim: { update: (a: unknown) => claimUpdateMock(a) },
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
