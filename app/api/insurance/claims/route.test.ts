// app/api/insurance/claims/route.test.ts
//
// Claim OUTCOMES are audited (see claims/[id]/route.ts), but the submission
// that opens the claim was not. That is the row establishing when a claim
// entered the book and for how much — the start of the FAIS/PPR clock.
import { afterEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { findFirstPolicy, createClaim, logAudit } = vi.hoisted(() => ({
  findFirstPolicy: vi.fn(),
  createClaim: vi.fn(),
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: true }) },
    insurancePolicy: { findFirst: findFirstPolicy },
    insuranceClaim: { create: createClaim },
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

const url = "http://localhost/api/insurance/claims"

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

describe("POST /api/insurance/claims — audit trail", () => {
  it("audits the submitted claim", async () => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1", status: "ACTIVE" })
    createClaim.mockResolvedValue({
      id: "claim-1",
      tenantId: "tenant-1",
      policyId: "policy-1",
      claimNumber: "CLM-0001",
      status: "SUBMITTED",
      claimAmount: 15000,
    })

    const res = await POST(postReq({ policyId: "policy-1", claimAmount: "15000" }))

    expect(res.status).toBe(201)
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        userEmail: "officer@acme-lending.example",
        action: "INSURANCE_CLAIM_SUBMITTED",
        entity: "InsuranceClaim",
        entityId: "claim-1",
        // The persisted row, not the request body: claimNumber and status are
        // server-assigned and appear nowhere in the input.
        newValue: expect.objectContaining({
          policyId: "policy-1",
          claimNumber: "CLM-0001",
          status: "SUBMITTED",
          claimAmount: 15000,
        }),
      })
    )
  })

  it("writes no audit row when the policy belongs to another tenant", async () => {
    findFirstPolicy.mockResolvedValue(null)

    const res = await POST(postReq({ policyId: "policy-other", claimAmount: "15000" }))

    expect(res.status).toBe(404)
    expect(createClaim).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })
})

// The "New Claim" form (app/(dashboard)/insurance/claims/new) posts here. A
// missing or nonsense amount reached `parseFloat` and then the database as NaN,
// a 500 the officer could do nothing with.
describe("POST /api/insurance/claims — the claimed amount", () => {
  it.each([[undefined], ["abc"], [-5], [0], [10.001]])("refuses %s with a 400 and creates nothing", async (claimAmount) => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1", status: "ACTIVE" })
    const res = await POST(postReq({ policyId: "policy-1", claimAmount }))
    expect(res.status).toBe(400)
    expect(createClaim).not.toHaveBeenCalled()
  })

  it("stores a valid amount given as a number", async () => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1", status: "ACTIVE" })
    createClaim.mockResolvedValue({ id: "claim-1" })
    const res = await POST(postReq({ policyId: "policy-1", claimAmount: 2500.5, claimType: "DEATH" }))
    expect(res.status).toBe(201)
    expect(createClaim).toHaveBeenCalledWith({ data: expect.objectContaining({ claimAmount: 2500.5, claimType: "DEATH" }) })
  })
})

// Blind review of #139 (LOW): a claim was accepted on a lapsed or cancelled
// policy, and a nonsense date reached the database as Invalid Date (a 500).
describe("POST /api/insurance/claims — policy status and dates", () => {
  it.each(["LAPSED", "CANCELLED", "CLAIMED"])("refuses a claim on a %s policy with 409", async (status) => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1", status })
    const res = await POST(postReq({ policyId: "policy-1", claimAmount: 1000 }))
    expect(res.status).toBe(409)
    expect(createClaim).not.toHaveBeenCalled()
  })

  it.each([["incidentDate"], ["fnolDate"]])("refuses an invalid %s with 400", async (field) => {
    findFirstPolicy.mockResolvedValue({ id: "policy-1", status: "ACTIVE" })
    const res = await POST(postReq({ policyId: "policy-1", claimAmount: 1000, [field]: "31/02/2026" }))
    expect(res.status).toBe(400)
    expect(createClaim).not.toHaveBeenCalled()
  })
})
