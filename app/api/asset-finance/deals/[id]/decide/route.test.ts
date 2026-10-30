import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  gate: vi.fn(),
  decideDeal: vi.fn(),
  matrix: vi.fn(),
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
vi.mock("@/lib/approval/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/approval/chain")>()),
  gateApproval: (a: unknown) => h.matrix(a),
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
  // Two reads of the deal: the screening's (the borrower) and the matrix's (the application's facts).
  h.dealFindFirst.mockImplementation(async (args: { select: { application: { select: Record<string, boolean> } } }) => (
    "appliedAmount" in args.select.application.select
      ? { application: { id: "app-1", appliedAmount: 900_000, productId: "p1", branchId: null, riskGradeRank: null, inputStaffIds: [] } }
      : { applicationId: "app-1", application: { clientId: "client-1", entityId: null } }
  ))
  h.matrix.mockResolvedValue({ kind: "none" })
  h.gate.mockResolvedValue({ allowed: true, state: { state: "CLEAR" }, message: "Screening is clear.", subjects: [], providerError: null })
  h.transaction.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({}))
  // The route preflights an approval (every gate, nothing written) before the matrix's say, then decides.
  h.decideDeal.mockImplementation(async (_tx, _actor, _id, _input, options?: { preflight?: boolean }) => (options?.preflight ? { kind: "ready" } : { kind: "decided", status: "APPROVED" }))
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

describe("POST /api/asset-finance/deals/[id]/decide — the approval matrix", () => {
  const decisions = () => h.decideDeal.mock.calls.filter((call) => !call[4]?.preflight)

  it("another level still to approve: its answer is returned, the deal is not decided, and the gate saw the deal's application", async () => {
    h.matrix.mockResolvedValue({ kind: "respond", status: 200, body: { ok: true, approvalRecorded: true, level: 1, requiredLevels: 2 } })
    const res = await POST(req("APPROVE"), ctx)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ approvalRecorded: true, level: 1 })
    expect(h.matrix).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "t1", automated: false, application: expect.objectContaining({ id: "app-1", appliedAmount: 900_000, productId: "p1" }) }))
    expect(decisions()).toHaveLength(0)
  })

  it("a refusal by the matrix (the maker, a missing authority) is returned as it is", async () => {
    h.matrix.mockResolvedValue({ kind: "respond", status: 403, body: { error: "no", approvalMatrix: "LEVEL_AUTHORITY_REQUIRED" } })
    const res = await POST(req("APPROVE"), ctx)
    expect(res.status).toBe(403)
    expect(decisions()).toHaveLength(0)
  })

  it("the approval that completes the chain records its step inside the decision's transaction", async () => {
    const recordFinalStep = vi.fn()
    h.matrix.mockResolvedValue({ kind: "final", recordFinalStep })
    expect((await POST(req("APPROVE"), ctx)).status).toBe(200)
    expect(decisions()).toHaveLength(1)
    expect(decisions()[0][4]).toEqual({ beforeApprove: recordFinalStep })
  })

  it("a gate on approving that refuses stops the matrix: no level is recorded for a deal that could not be approved", async () => {
    h.decideDeal.mockResolvedValue({ kind: "memo_required" })
    const res = await POST(req("APPROVE"), ctx)
    expect(res.status).toBe(409)
    expect(h.matrix).not.toHaveBeenCalled()
  })

  it("a decline or a referral does not go through the matrix", async () => {
    await POST(req("DECLINE"), ctx)
    await POST(req("REFER"), ctx)
    expect(h.matrix).not.toHaveBeenCalled()
    expect(decisions()).toHaveLength(2)
  })

  it("the database's refusal for the matrix is its own answer, not the stale-deal one", async () => {
    h.transaction.mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      const result = await cb({})
      if ((result as { kind: string }).kind === "ready") return result
      throw new Error("Raw query failed. Code: `23514`. Message: `Approval matrix: with the matrix in force an application is approved only through its approval chain`")
    })
    const res = await POST(req("APPROVE"), ctx)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ approvalMatrix: "CHAIN_INCOMPLETE" })
  })
})
