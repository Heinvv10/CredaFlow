// app/api/insurance/commissions/[id]/route.test.ts
//
// CLAUDE.md: "Every state-changing user action runs through lib/audit.ts.
// Don't bypass it for 'just this one path' — auditors will ask."
//
// Every transition on this route moves money or reverses it: APPROVED clears a
// commission for payment, PAID asserts it left the business, and CLAWED_BACK
// reverses it on a free-text reason a human typed. Without an audit row there
// is no record of who did any of it.
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { findFirstCommission, updateCommission, logAudit } = vi.hoisted(() => ({
  findFirstCommission: vi.fn(),
  updateCommission: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    advisorCommission: { findFirst: findFirstCommission, update: updateCommission },
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

import { PATCH } from "./route"

const ctx = { params: Promise.resolve({ id: "comm-1" }) }
const url = "http://localhost/api/insurance/commissions/comm-1"

const PENDING = {
  id: "comm-1",
  tenantId: "tenant-1",
  advisorId: "advisor-1",
  policyId: "policy-1",
  period: "2026-08",
  amount: 250.5,
  status: "PENDING",
}

function patchReq(body: unknown) {
  return new NextRequest(url, {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("PATCH /api/insurance/commissions/[id] — audit trail", () => {
  it("audits an approval", async () => {
    findFirstCommission.mockResolvedValue({ ...PENDING })
    updateCommission.mockResolvedValue({ ...PENDING, status: "APPROVED" })

    const res = await PATCH(patchReq({ action: "approve" }), ctx)

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        userEmail: "admin@acme-lending.example",
        action: "INSURANCE_COMMISSION_APPROVED",
        entity: "AdvisorCommission",
        entityId: "comm-1",
        oldValue: expect.objectContaining({ status: "PENDING" }),
        newValue: expect.objectContaining({ status: "APPROVED" }),
      })
    )
  })

  it("audits a payment — the row that asserts money left the business", async () => {
    findFirstCommission.mockResolvedValue({ ...PENDING, status: "APPROVED" })
    const paidAt = new Date("2026-08-16T00:00:00Z")
    updateCommission.mockResolvedValue({ ...PENDING, status: "PAID", paidAt })

    const res = await PATCH(patchReq({ action: "pay" }), ctx)

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_COMMISSION_PAID",
        entity: "AdvisorCommission",
        entityId: "comm-1",
        oldValue: expect.objectContaining({ status: "APPROVED" }),
        newValue: expect.objectContaining({ status: "PAID", paidAt }),
      })
    )
  })

  it("audits a clawback and preserves the operator's stated reason", async () => {
    findFirstCommission.mockResolvedValue({ ...PENDING, status: "PAID" })
    updateCommission.mockResolvedValue({
      ...PENDING,
      status: "CLAWED_BACK",
      clawbackReason: "Policy lapsed inside the clawback window",
    })

    const res = await PATCH(patchReq({ action: "claw_back", clawbackReason: "Policy lapsed inside the clawback window" }), ctx)

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSURANCE_COMMISSION_CLAWED_BACK",
        entityId: "comm-1",
        newValue: expect.objectContaining({
          status: "CLAWED_BACK",
          clawbackReason: "Policy lapsed inside the clawback window",
        }),
      })
    )
  })

  // The audit row is evidence of what the database holds. Logging the parsed
  // request instead would record what was asked for, not what happened.
  it("audits the persisted row rather than the request body", async () => {
    findFirstCommission.mockResolvedValue({ ...PENDING })
    updateCommission.mockResolvedValue({
      ...PENDING,
      status: "APPROVED",
      amount: 250.5,
      period: "2026-08",
    })

    await PATCH(patchReq({ action: "approve" }), ctx)

    expect(logAudit.mock.calls[0][0].newValue).toMatchObject({
      id: "comm-1",
      advisorId: "advisor-1",
      policyId: "policy-1",
      amount: 250.5,
      status: "APPROVED",
    })
  })

  it("writes no audit row when a rejected transition changes nothing", async () => {
    // PAID requires APPROVED first; this one is still PENDING.
    findFirstCommission.mockResolvedValue({ ...PENDING })

    const res = await PATCH(patchReq({ action: "pay" }), ctx)

    expect(res.status).toBe(400)
    expect(updateCommission).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("writes no audit row for a clawback with no reason", async () => {
    findFirstCommission.mockResolvedValue({ ...PENDING, status: "PAID" })

    const res = await PATCH(patchReq({ action: "claw_back" }), ctx)

    expect(res.status).toBe(400)
    expect(logAudit).not.toHaveBeenCalled()
  })
})
