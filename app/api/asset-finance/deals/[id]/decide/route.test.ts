import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  gate: vi.fn(),
  decideDeal: vi.fn(),
  dealFindFirst: vi.fn(),
  transaction: vi.fn(),
  auditRefusal: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: () => h.requireApiRole(),
  canDo: () => true,
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/asset-finance/require-enabled", () => ({ requireAssetFinanceEnabled: async () => null }))
vi.mock("@/lib/asset-finance/deal-detail", () => ({ loadDealDetail: async () => ({ id: "deal-1" }) }))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: (a: unknown) => h.auditRefusal(a) }))
vi.mock("@/lib/asset-finance/deal-decision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-finance/deal-decision")>()),
  decideDeal: (...a: unknown[]) => h.decideDeal(...a),
}))
vi.mock("@/lib/screening/gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/screening/gate")>()),
  borrowerScreeningGate: (a: unknown) => h.gate(a),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    assetFinanceDeal: { findFirst: (a: unknown) => h.dealFindFirst(a) },
    $transaction: (cb: (tx: unknown) => Promise<unknown>) => h.transaction(cb),
  },
}))

import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "deal-1" }) }
const req = (decision: string) => new NextRequest("http://x", { method: "POST", body: JSON.stringify({ decision, reasons: ["Synthetic reason for the test"] }) })

beforeEach(() => {
  vi.clearAllMocks()
  h.requireApiRole.mockResolvedValue({ user: { id: "u1", email: "u@test.invalid", role: "LOAN_ADMIN", tenantId: "t1" } })
  h.dealFindFirst.mockResolvedValue({ applicationId: "app-1", application: { clientId: "client-1", entityId: null } })
  h.gate.mockResolvedValue({ allowed: true, state: { state: "CLEAR" }, message: "Screening is clear.", subjects: [], providerError: null })
  h.transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({}))
  h.decideDeal.mockResolvedValue({ kind: "decided", status: "APPROVED" })
})

describe("POST /api/asset-finance/deals/[id]/decide — screening (REPRO 6 / M3, H3)", () => {
  it("screens the deal's borrower before approval and refuses with an audited 422, never reaching the decision", async () => {
    h.gate.mockResolvedValue({ allowed: false, state: { state: "BLOCKED", reason: "SANCTIONS_MATCH", checkIds: ["s"] }, message: "The client: A confirmed sanctions match. This cannot be overridden.", subjects: [], providerError: null })
    const res = await POST(req("APPROVE"), ctx)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain("confirmed sanctions match")
    expect(h.gate).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", applicationId: "app-1", borrower: { clientId: "client-1", entityId: null } }))
    expect(h.decideDeal).not.toHaveBeenCalled()
    expect(h.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ reason: "screening_blocked", status: 422 }))
  })

  it("screens an entity borrower (the gate gets the entity, which brings its related parties)", async () => {
    h.dealFindFirst.mockResolvedValue({ applicationId: "app-2", application: { clientId: null, entityId: "entity-1" } })
    await POST(req("APPROVE"), ctx)
    expect(h.gate).toHaveBeenCalledWith(expect.objectContaining({ borrower: { clientId: null, entityId: "entity-1" } }))
  })

  it("maps the screening trigger's refusal to 422, not the stale-deal 409", async () => {
    h.transaction.mockRejectedValue(new Error("Raw query failed. Code: `23514`. Message: `Application app-1 cannot be approved: its borrower's screening blocks approval`"))
    const res = await POST(req("APPROVE"), ctx)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toContain("screening changed")
  })

  it("maps an in-transaction screening change to 422", async () => {
    h.decideDeal.mockResolvedValue({ kind: "screening_blocked" })
    expect((await POST(req("APPROVE"), ctx)).status).toBe(422)
  })

  it("does not screen a decline", async () => {
    h.decideDeal.mockResolvedValue({ kind: "decided", status: "DECLINED" })
    expect((await POST(req("DECLINE"), ctx)).status).toBe(200)
    expect(h.gate).not.toHaveBeenCalled()
  })
})
