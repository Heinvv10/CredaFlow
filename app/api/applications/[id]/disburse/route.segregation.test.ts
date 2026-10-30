import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/**
 * Segregation of duties at payout: while the lender's setting is on, the staff
 * member who approved the application cannot disburse it. The refusal comes
 * before any other payout gate and is audited through the route's refusal seam.
 * The database refuses the same write (lib/security/segregation-of-duties.integration.test.ts).
 */

const h = vi.hoisted(() => ({
  findUnique: vi.fn(),
  sodRequired: vi.fn(),
  screening: vi.fn(),
  auditRefusal: vi.fn(),
}))

// The key-facts redirect reads the application by its own query; these routes are exercised as PASQ applications.
vi.mock("@/lib/non-nca-documents/refusal", () => ({ keyFactsRefusal: async () => null }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "admin@acme-lending.example", role: "ADMIN" },
  }),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { loanApplication: { findUnique: (...args: unknown[]) => h.findUnique(...args) } },
}))
vi.mock("@/lib/security/segregation-of-duties", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/security/segregation-of-duties")>(),
  isSegregationOfDutiesRequired: (...args: unknown[]) => h.sodRequired(...args),
}))
vi.mock("@/lib/screening/gate", () => ({ readBorrowerScreening: (...args: unknown[]) => h.screening(...args) }))
vi.mock("@/lib/audit-refusals", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/audit-refusals")>(),
  auditRefusal: (...args: unknown[]) => h.auditRefusal(...args),
}))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "app-1" }) }
const request = () => new NextRequest("http://localhost/api/applications/app-1/disburse", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({}),
})
const approvedBy = (approvedById: string) => ({
  id: "app-1",
  tenantId: "tenant-1",
  status: "APPROVED",
  clientId: "client-1",
  entityId: null,
  approvedById,
  client: {},
  product: {},
})

beforeEach(() => {
  vi.clearAllMocks()
  h.sodRequired.mockResolvedValue(true)
  // Stops a payout that got past segregation of duties at the next gate.
  h.screening.mockResolvedValue({ allowed: false, message: "screening stop", state: "HIT" })
})

describe("POST /api/applications/[id]/disburse — segregation of duties", () => {
  it("refuses the approver while the setting is on, before any other gate, and audits it", async () => {
    h.findUnique.mockResolvedValue(approvedBy("user-1"))

    const response = await POST(request(), ctx)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: "Segregation of duties: you approved this application, so another staff member must disburse it.",
      disbursementPrecondition: "segregation_of_duties",
    })
    expect(h.sodRequired).toHaveBeenCalledWith("tenant-1")
    expect(h.screening).not.toHaveBeenCalled()
    expect(h.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "LOAN_DISBURSEMENT_REFUSED", reason: "segregation_of_duties", status: 403, userId: "user-1",
    }))
  })

  it("lets the approver continue while the setting is off", async () => {
    h.findUnique.mockResolvedValue(approvedBy("user-1"))
    h.sodRequired.mockResolvedValue(false)

    const response = await POST(request(), ctx)

    expect(await response.json()).toEqual(expect.objectContaining({ disbursementPrecondition: "screening" }))
  })

  it("lets a different staff member continue while the setting is on", async () => {
    h.findUnique.mockResolvedValue(approvedBy("user-2"))

    const response = await POST(request(), ctx)

    expect(await response.json()).toEqual(expect.objectContaining({ disbursementPrecondition: "screening" }))
  })
})
