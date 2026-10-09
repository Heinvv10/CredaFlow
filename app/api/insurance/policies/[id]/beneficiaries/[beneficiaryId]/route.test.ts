// app/api/insurance/policies/[id]/beneficiaries/[beneficiaryId]/route.test.ts
//
// This DELETE is destructive and irreversible: it removes the person who would
// be paid out on a death claim, and the row it destroys carries an idNumber and
// a date of birth. Without an audit row there is nothing left to show the
// beneficiary ever existed, let alone who removed them.
//
// The audit row records identity WITHOUT copying the idNumber or date of birth
// into AuditLog — see the sibling POST test for why.
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { findFirstPolicy, findFirstBeneficiary, deleteBeneficiary, logAudit } = vi.hoisted(() => ({
  findFirstPolicy: vi.fn(),
  findFirstBeneficiary: vi.fn(),
  deleteBeneficiary: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insurancePolicy: { findFirst: findFirstPolicy },
    insuranceBeneficiary: { findFirst: findFirstBeneficiary, delete: deleteBeneficiary },
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

import { DELETE } from "./route"

const ctx = { params: Promise.resolve({ id: "policy-1", beneficiaryId: "ben-1" }) }
const url = "http://localhost/api/insurance/policies/policy-1/beneficiaries/ben-1"

const ID_NUMBER = "9001016000085"

const EXISTING = {
  id: "ben-1",
  policyId: "policy-1",
  firstName: "Thandi",
  lastName: "Mokoena",
  relationship: "SPOUSE",
  idNumber: ID_NUMBER,
  dateOfBirth: new Date("1990-01-01"),
  coverAmount: 25000,
}

function deleteReq() {
  return new NextRequest(url, { method: "DELETE" })
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("DELETE /api/insurance/policies/[id]/beneficiaries/[beneficiaryId] — audit trail", () => {
  it("audits the removal, recording the row that was destroyed", async () => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1" })
    findFirstBeneficiary.mockResolvedValue({ ...EXISTING })
    deleteBeneficiary.mockResolvedValue({ id: "ben-1" })

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(200)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        userEmail: "officer@acme-lending.example",
        action: "INSURANCE_BENEFICIARY_REMOVED",
        entity: "InsuranceBeneficiary",
        entityId: "ben-1",
        // A destruction is recorded as one: the prior row goes in oldValue.
        oldValue: expect.objectContaining({
          policyId: "policy-1",
          relationship: "SPOUSE",
          coverAmount: 25000,
        }),
      })
    )
  })

  it("keeps the idNumber and date of birth out of the audit row", async () => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1" })
    findFirstBeneficiary.mockResolvedValue({ ...EXISTING })
    deleteBeneficiary.mockResolvedValue({ id: "ben-1" })

    await DELETE(deleteReq(), ctx)

    const logged = logAudit.mock.calls[0][0]
    const serialised = JSON.stringify(logged)
    expect(serialised).not.toContain(ID_NUMBER)
    expect(serialised).not.toContain("1990-01-01")
    expect(logged.oldValue).not.toHaveProperty("idNumber")
    expect(logged.oldValue).not.toHaveProperty("dateOfBirth")
  })

  it("writes no audit row when the policy belongs to another tenant", async () => {
    findFirstPolicy.mockResolvedValue(null)

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(404)
    expect(deleteBeneficiary).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("writes no audit row when the beneficiary is not on this policy", async () => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1" })
    findFirstBeneficiary.mockResolvedValue(null)

    const res = await DELETE(deleteReq(), ctx)

    expect(res.status).toBe(404)
    expect(deleteBeneficiary).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })
})
