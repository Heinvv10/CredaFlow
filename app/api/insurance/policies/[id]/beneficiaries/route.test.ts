// app/api/insurance/policies/[id]/beneficiaries/route.test.ts
//
// A beneficiary is who gets paid when the life covered dies, so adding one is
// an auditable act. It is also the most PII-dense row in the module — it
// carries an idNumber and a date of birth — so the audit row deliberately
// records identity WITHOUT copying those two values into AuditLog. POPIA:
// the audit trail should prove who changed what, not duplicate the identifiers
// into a second store with a different retention.
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { findFirstPolicy, createBeneficiary, logAudit } = vi.hoisted(() => ({
  findFirstPolicy: vi.fn(),
  createBeneficiary: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insurancePolicy: { findFirst: findFirstPolicy },
    insuranceBeneficiary: { create: createBeneficiary, findMany: vi.fn() },
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

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "policy-1" }) }
const url = "http://localhost/api/insurance/policies/policy-1/beneficiaries"

const ID_NUMBER = "9001016000085"

function postReq(body: unknown) {
  return new NextRequest(url, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

const VALID = {
  firstName: "Thandi",
  lastName: "Mokoena",
  relationship: "SPOUSE",
  idNumber: ID_NUMBER,
  dateOfBirth: "1990-01-01",
  coverAmount: 25000,
}

afterEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/insurance/policies/[id]/beneficiaries — audit trail", () => {
  it("audits the added beneficiary", async () => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1", tenantId: "tenant-1" })
    createBeneficiary.mockResolvedValue({
      id: "ben-1",
      policyId: "policy-1",
      firstName: "Thandi",
      lastName: "Mokoena",
      relationship: "SPOUSE",
      idNumber: ID_NUMBER,
      dateOfBirth: new Date("1990-01-01"),
      coverAmount: 25000,
    })

    const res = await POST(postReq(VALID), ctx)

    expect(res.status).toBe(201)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        userEmail: "officer@acme-lending.example",
        action: "INSURANCE_BENEFICIARY_ADDED",
        entity: "InsuranceBeneficiary",
        // The id is server-assigned, so this proves the PERSISTED row was
        // logged rather than the request body.
        entityId: "ben-1",
        newValue: expect.objectContaining({
          policyId: "policy-1",
          relationship: "SPOUSE",
          coverAmount: 25000,
        }),
      })
    )
  })

  it("keeps the idNumber and date of birth out of the audit row", async () => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1", tenantId: "tenant-1" })
    createBeneficiary.mockResolvedValue({
      id: "ben-1",
      policyId: "policy-1",
      firstName: "Thandi",
      lastName: "Mokoena",
      relationship: "SPOUSE",
      idNumber: ID_NUMBER,
      dateOfBirth: new Date("1990-01-01"),
      coverAmount: 25000,
    })

    await POST(postReq(VALID), ctx)

    const logged = logAudit.mock.calls[0][0]
    // Assert on the SERIALISED row: a nested copy would slip past a key check.
    const serialised = JSON.stringify(logged)
    expect(serialised).not.toContain(ID_NUMBER)
    expect(serialised).not.toContain("1990-01-01")
    expect(logged.newValue).not.toHaveProperty("idNumber")
    expect(logged.newValue).not.toHaveProperty("dateOfBirth")
  })

  it("writes no audit row when the policy belongs to another tenant", async () => {
    findFirstPolicy.mockResolvedValue(null)

    const res = await POST(postReq(VALID), ctx)

    expect(res.status).toBe(404)
    expect(createBeneficiary).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("writes no audit row when validation rejects the body", async () => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1", tenantId: "tenant-1" })

    const res = await POST(postReq({ firstName: "Thandi" }), ctx)

    expect(res.status).toBe(400)
    expect(logAudit).not.toHaveBeenCalled()
  })
})
