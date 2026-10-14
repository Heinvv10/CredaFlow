import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  transaction: vi.fn(),
  tenantConfigFind: vi.fn(),
  clientFind: vi.fn(),
}))

const tx = {
  $executeRaw: vi.fn().mockResolvedValue(0),
  tenantConfig: { findUnique: (...args: unknown[]) => h.tenantConfigFind(...args) },
  client: { findUnique: (...args: unknown[]) => h.clientFind(...args) },
}

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...args: unknown[]) => h.requireRole(...args) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (tenant: { id: string }) => Promise<unknown>) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/affordability/evidence-locks", () => ({ lockAffordabilityClientEvidence: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: (fn: (client: typeof tx) => Promise<unknown>, options: unknown) => h.transaction(fn, options) },
}))

import { POST } from "./route"

const params = { params: Promise.resolve({ id: "client-1" }) }
const request = () => new NextRequest("http://localhost/api/clients/client-1/kyc-in-person-verification", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    method: "IN_PERSON_BRANCH",
    note: "Synthetic in-person verification note is complete.",
  }),
})

describe("POST /api/clients/[id]/kyc-in-person-verification policy", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.requireRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.invalid", role: "ADMIN", totpVerified: true },
    })
    h.transaction.mockImplementation((fn: (client: typeof tx) => Promise<unknown>) => fn(tx))
    h.tenantConfigFind.mockResolvedValue({
      kycOverrideEnabled: true,
      kycOverrideMinRole: "ADMIN",
      kycOverrideSecondApprover: false,
      requireStaffTotp: true,
    })
    h.clientFind.mockResolvedValue(null)
  })

  it("refuses a caller below the lender minimum role", async () => {
    h.requireRole.mockResolvedValue({
      user: { id: "manager-1", email: "manager@test.invalid", role: "BRANCH_MANAGER", totpVerified: true },
    })
    const response = await POST(request(), params)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe("role_below_policy")
  })

  it("requires TOTP when the lender requires staff TOTP", async () => {
    h.requireRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.invalid", role: "ADMIN", totpVerified: false },
    })
    const response = await POST(request(), params)
    expect(response.status).toBe(403)
    expect((await response.json()).code).toBe("totp_required")
  })

  it("allows the policy check without TOTP when the lender does not require it", async () => {
    h.requireRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@test.invalid", role: "ADMIN", totpVerified: false },
    })
    h.tenantConfigFind.mockResolvedValue({
      kycOverrideEnabled: true,
      kycOverrideMinRole: "ADMIN",
      kycOverrideSecondApprover: false,
      requireStaffTotp: false,
    })
    const response = await POST(request(), params)
    expect(response.status).toBe(404)
    expect((await response.json()).error).toBe("Client not found")
  })

  it("requires the request workflow when second approval is enabled", async () => {
    h.tenantConfigFind.mockResolvedValue({
      kycOverrideEnabled: true,
      kycOverrideMinRole: "ADMIN",
      kycOverrideSecondApprover: true,
      requireStaffTotp: true,
    })
    const response = await POST(request(), params)
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe("second_approver_required")
  })
})
