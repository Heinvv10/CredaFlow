import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  decideReferenceRate: vi.fn(),
  auditRefusal: vi.fn(),
  requireAssetFinanceEnabled: vi.fn(),
  basis: { value: "PRIME" as string | null },
}))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/asset-finance/require-enabled", () => ({ requireAssetFinanceEnabled: m.requireAssetFinanceEnabled }))
// Only the session guard is mocked: canDo is the real permission map.
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: () => m.requireApiRole(),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, handler: (tenant: { id: string }) => unknown) => handler({ id: "t1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (fn: (tx: unknown) => unknown) => fn("tx"),
    referenceRate: { findFirst: vi.fn(async () => (m.basis.value ? { basis: m.basis.value } : null)) },
  },
}))
vi.mock("@/lib/asset-finance/reference-rate-decision", () => ({ decideReferenceRate: m.decideReferenceRate }))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))

import { POST } from "./route"

const decide = (body: unknown) => POST(
  new NextRequest("http://localhost/api/asset-finance/reference-rates/rr1/decide", { method: "POST", body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: "rr1" }) },
)
const signIn = (id: string, role: string) => m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@test.invalid`, role } })
const APPROVED = {
  id: "rr1", tenantId: "t1", basis: "PRIME", effectiveDate: new Date("2027-01-15T00:00:00Z"), rate: new Prisma.Decimal("0.12"),
  status: "APPROVED", requestedById: "u1", decidedById: "u2", decidedAt: new Date("2027-01-16T08:00:00Z"), createdAt: new Date("2027-01-10T08:00:00Z"),
}

beforeEach(() => {
  signIn("u2", "LOAN_ADMIN")
  m.auditRefusal.mockReset()
  m.requireAssetFinanceEnabled.mockReset().mockResolvedValue(null)
  m.decideReferenceRate.mockReset()
  m.basis.value = "PRIME"
})

describe("POST /api/asset-finance/reference-rates/[id]/decide", () => {
  it("answers 404 and decides nothing when asset finance is off", async () => {
    m.requireAssetFinanceEnabled.mockResolvedValue(NextResponse.json({ error: "Not found" }, { status: 404 }))
    expect((await decide({ decision: "APPROVE" })).status).toBe(404)
    expect(m.decideReferenceRate).not.toHaveBeenCalled()
  })

  it("decides a REPO rate without asset finance, under manage_repo_rate", async () => {
    m.requireAssetFinanceEnabled.mockResolvedValue(NextResponse.json({ error: "Not found" }, { status: 404 }))
    m.basis.value = "REPO"
    m.decideReferenceRate.mockResolvedValue({ kind: "decided", rate: { ...APPROVED, basis: "REPO" }, reach: null })
    expect((await decide({ decision: "APPROVE" })).status).toBe(200)
    expect(m.decideReferenceRate).toHaveBeenCalled()
  })

  it("answers 404 for a rate that is not this tenant's", async () => {
    m.basis.value = null
    expect((await decide({ decision: "APPROVE" })).status).toBe(404)
    expect(m.decideReferenceRate).not.toHaveBeenCalled()
  })

  it("refuses a CREDIT_OFFICER with an audited 403", async () => {
    signIn("u3", "CREDIT_OFFICER")
    expect((await decide({ decision: "APPROVE" })).status).toBe(403)
    expect(m.decideReferenceRate).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "REFERENCE_RATE_REFUSED", entityId: "rr1", userId: "u3", reason: "insufficient_role", status: 403,
    }))
  })

  it("answers 400 to a body without APPROVE or REJECT", async () => {
    expect((await decide({ decision: "MAYBE" })).status).toBe(400)
    expect(m.decideReferenceRate).not.toHaveBeenCalled()
  })

  it("refuses the requester deciding their own rate with an audited 403 (four-eyes)", async () => {
    m.decideReferenceRate.mockResolvedValue({ kind: "self_decision" })
    expect((await decide({ decision: "APPROVE" })).status).toBe(403)
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ reason: "four_eyes_self_decision", status: 403, userId: "u2" }))
  })

  it("answers 404 and 409 for a missing or already decided rate", async () => {
    m.decideReferenceRate.mockResolvedValue({ kind: "not_found" })
    expect((await decide({ decision: "REJECT" })).status).toBe(404)
    m.decideReferenceRate.mockResolvedValue({ kind: "not_pending", status: "APPROVED" })
    expect((await decide({ decision: "REJECT" })).status).toBe(409)
    expect(m.auditRefusal).not.toHaveBeenCalled()
  })

  it("decides as the caller, for the request's tenant, and returns the rate with its reach", async () => {
    const reach = { wouldReprice: 0, alreadyLater: 2, superseded: false, backdated: true, alerted: true }
    m.decideReferenceRate.mockResolvedValue({ kind: "decided", rate: APPROVED, reach })
    const response = await decide({ decision: "APPROVE" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ id: "rr1", status: "APPROVED", decidedById: "u2", effectiveDate: "2027-01-15", reach })
    expect(m.decideReferenceRate).toHaveBeenCalledWith("tx", expect.objectContaining({
      tenantId: "t1", rateId: "rr1", decision: "APPROVE", deciderId: "u2", today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    }))
  })
})
