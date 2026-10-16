import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  flag: { on: true },
  requireApiRole: vi.fn(),
  auditRefusal: vi.fn(),
  logAuditStrict: vi.fn(),
  createDeal: vi.fn(),
  submitDeal: vi.fn(),
  decideDeal: vi.fn(),
  recordDealFinancials: vi.fn(),
  solveWithRate: vi.fn(),
  subjects: vi.fn(),
  runCheck: vi.fn(),
  dealFindFirst: vi.fn(),
  assetFindFirst: vi.fn(),
}))

vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    assetFinanceDeal: { findFirst: m.dealFindFirst },
    financedAsset: { findFirst: m.assetFindFirst },
    $transaction: (fn: (tx: unknown) => unknown) => fn({}),
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) => fn({ id: "tenant-1", name: "T" }),
}))
// Only the session guard is mocked: canDo is the real permission map.
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: () => m.requireApiRole(),
}))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAuditStrict: m.logAuditStrict,
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))
vi.mock("@/lib/asset-finance/deal-create", () => ({ createDeal: m.createDeal }))
vi.mock("@/lib/asset-finance/deal-submit", () => ({ submitDeal: m.submitDeal }))
vi.mock("@/lib/asset-finance/deal-decision", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-finance/deal-decision")>()),
  decideDeal: m.decideDeal,
}))
vi.mock("@/lib/asset-finance/deal-financials", () => ({ recordDealFinancials: m.recordDealFinancials }))
vi.mock("@/lib/asset-finance/deal-structure", () => ({ solveWithRate: m.solveWithRate }))
vi.mock("@/lib/asset-finance/deal-bureau", () => ({
  dealBureauSubjects: m.subjects, runDealBureauCheck: m.runCheck, recentlyCheckedClientIds: async () => new Set(), dealRecheckWindowDays: async () => 30,
}))
vi.mock("@/lib/asset-finance/deal-detail", () => ({ loadDealDetail: async (_t: string, id: string) => ({ id }) }))

import { POST as create } from "./route"
import { POST as preview } from "./preview/route"
import { POST as submit } from "./[id]/submit/route"
import { POST as decide } from "./[id]/decide/route"
import { POST as bureau } from "./[id]/bureau-checks/route"
import { PUT as financials } from "./[id]/financials/route"

const signIn = (role: string, id = "user-1") =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })
const req = (body: unknown, method = "POST") => new NextRequest("http://localhost/api/asset-finance/deals", {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})
const ctx = { params: Promise.resolve({ id: "deal-1" }) }
const structure = {
  assetId: "asset-1", contractType: "INSTALMENT_SALE", firstDueDate: "2099-01-31", preset: { kind: "MONTHLY", periods: 12 }, rateBasis: "FIXED", fixedRate: "0.12",
}
const memo = {
  periodEnd: "2026-02-28", turnoverCents: 1, ebitdaCents: 1, totalAssetsCents: 1, totalLiabilitiesCents: 1,
  existingDebtServiceCents: 1, avgMonthlyCreditsCents: 1, returnedDebitsCount: 0,
}
const REASONS = ["Strong DSCR on audited AFS"]

const calls = {
  create: () => create(req({ ...structure, entityId: "e", supplierId: "s", productId: "p" })),
  preview: () => preview(req(structure)),
  submit: () => submit(req({}), ctx),
  bureau: () => bureau(req({}), ctx),
  financials: () => financials(req(memo, "PUT"), ctx),
  decide: () => decide(req({ decision: "DECLINE", reasons: REASONS }), ctx),
}
const effects = [m.createDeal, m.solveWithRate, m.submitDeal, m.runCheck, m.recordDealFinancials, m.decideDeal]

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn("CREDIT_OFFICER")
  m.createDeal.mockResolvedValue({ kind: "created", dealId: "deal-1" })
  m.submitDeal.mockResolvedValue({ kind: "submitted", awaitingRegimeApproval: true, regime: "NCA", rule: "R" })
  m.recordDealFinancials.mockResolvedValue({ kind: "recorded", ratios: { dscr: "1.0000", gearing: null, proposedAnnualInstalmentsCents: 1 } })
  m.decideDeal.mockResolvedValue({ kind: "decided", status: "DECLINED" })
  m.solveWithRate.mockResolvedValue({ ok: true, startDate: "2098-12-31", termDays: 365, rate: {}, result: { rows: [] } })
  m.dealFindFirst.mockResolvedValue({ id: "deal-1", status: "SUBMITTED", entityId: "e", applicationId: "app-1" })
  m.assetFindFirst.mockResolvedValue({ cashPriceExclVatCents: 100, vatCents: 15 })
  m.subjects.mockResolvedValue([{ clientId: "c-1", role: "DIRECTOR", trusteeKind: null }])
  m.runCheck.mockResolvedValue("stored")
})

describe("asset-finance deal routes", () => {
  it.each(Object.keys(calls))("%s answers 404 when the tenant has not enabled asset finance", async (name) => {
    m.flag.on = false
    expect((await calls[name as keyof typeof calls]()).status).toBe(404)
    for (const effect of effects) expect(effect).not.toHaveBeenCalled()
  })

  it.each(["create", "preview", "submit", "bureau", "financials"])("%s refuses a READONLY user 403", async (name) => {
    signIn("READONLY")
    expect((await calls[name as keyof typeof calls]()).status).toBe(403)
    for (const effect of effects) expect(effect).not.toHaveBeenCalled()
  })

  it.each(["create", "preview", "submit", "bureau", "financials"])("%s works for a CREDIT_OFFICER", async (name) => {
    expect((await calls[name as keyof typeof calls]()).status).toBeLessThan(300)
  })

  it("decide refuses a CREDIT_OFFICER 403 (decide_asset_finance) and audits it", async () => {
    expect((await calls.decide()).status).toBe(403)
    expect(m.decideDeal).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "ASSET_DEAL_DECISION_REFUSED", reason: "insufficient_role", status: 403, entityId: "deal-1",
    }))
  })

  it("answers 400 with the failing fields and runs nothing", async () => {
    expect((await create(req({ ...structure, rateBasis: "PRIME" }))).status).toBe(400)
    const bad = await financials(req({ ...memo, ebitdaCents: 1.5, totalAssetsCents: -1 }, "PUT"), ctx)
    expect(bad.status).toBe(400)
    expect(Object.keys((await bad.json()).fields).sort()).toEqual(["ebitdaCents", "totalAssetsCents"])
    expect(m.createDeal).not.toHaveBeenCalled()
    expect(m.recordDealFinancials).not.toHaveBeenCalled()
  })

  it("maps createDeal refusals to their status", async () => {
    m.createDeal.mockResolvedValue({ kind: "refused", status: 409, error: "The asset is already on an open deal (BOOKED)" })
    const res = await calls.create()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/open deal/)
  })

  it("preview writes nothing and answers an unsolvable structure 200 with the solver's reason and no schedule", async () => {
    m.solveWithRate.mockResolvedValue({ ok: false, error: "balloonCents: must be less than the financed amount" })
    const res = await calls.preview()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ error: "balloonCents: must be less than the financed amount" })
    expect(m.logAuditStrict).not.toHaveBeenCalled()
  })

  it("submit reports a refused NCA deal and a pending override", async () => {
    m.submitDeal.mockResolvedValue({ kind: "refused_nca", reason: "NCA applies: slice 1 finances non-NCA deals only (X)", rule: "X" })
    expect(await (await calls.submit()).json()).toMatchObject({ refusedNca: true, awaitingRegimeApproval: false })
    m.submitDeal.mockResolvedValue({ kind: "submitted", awaitingRegimeApproval: true, regime: "NCA", rule: "R" })
    expect(await (await calls.submit()).json()).toMatchObject({ refusedNca: false, awaitingRegimeApproval: true })
  })

  it("bureau checks run once per director/trustee and are audited; none on file is 422", async () => {
    const res = await calls.bureau()
    expect(await res.json()).toMatchObject({ results: [{ clientId: "c-1", role: "DIRECTOR", outcome: "stored" }] })
    expect(m.runCheck).toHaveBeenCalledWith("tenant-1", "app-1", { clientId: "c-1", role: "DIRECTOR", trusteeKind: null }, {
      force: false, startedAt: expect.any(Date),
    })
    expect(m.logAuditStrict).toHaveBeenCalledWith(expect.objectContaining({ action: "ASSET_DEAL_BUREAU_CHECKED", entityId: "deal-1" }))
    m.subjects.mockResolvedValue([])
    expect((await calls.bureau()).status).toBe(422)
  })

  describe("decide (LOAN_ADMIN)", () => {
    beforeEach(() => signIn("LOAN_ADMIN", "admin-a"))

    it.each([
      [{ decision: "APPROVE" }],
      [{ decision: "DECLINE", reasons: [] }],
      [{ decision: "REFER", reasons: ["no"] }],
    ])("reasons are mandatory: %j → 400, nothing decided", async (body) => {
      expect((await decide(req(body), ctx)).status).toBe(400)
      expect(m.decideDeal).not.toHaveBeenCalled()
    })

    it("APPROVE without a credit memo is 409 and audited", async () => {
      m.decideDeal.mockResolvedValue({ kind: "memo_required" })
      const res = await decide(req({ decision: "APPROVE", reasons: REASONS }), ctx)
      expect(res.status).toBe(409)
      expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ reason: "credit_memo_required", status: 409 }))
    })

    it("APPROVE while the override is pending is 409 with the second-approver message", async () => {
      m.decideDeal.mockResolvedValue({ kind: "awaiting_override" })
      const res = await decide(req({ decision: "APPROVE", reasons: REASONS }), ctx)
      expect(res.status).toBe(409)
      expect((await res.json()).error).toBe("The NON_NCA override awaits a second approver")
    })

    it("APPROVE on an NCA deal is answered 409 with the refusal reason (the refusal itself commits)", async () => {
      m.decideDeal.mockResolvedValue({ kind: "refused_nca", reason: "NCA applies: slice 1 finances non-NCA deals only (X)" })
      const res = await decide(req({ decision: "APPROVE", reasons: REASONS }), ctx)
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/^NCA applies/), deal: { id: "deal-1" } })
    })

    it("passes the trimmed reasons to the decision", async () => {
      expect((await decide(req({ decision: "DECLINE", reasons: ["  Gearing above policy  "] }), ctx)).status).toBe(200)
      expect(m.decideDeal).toHaveBeenCalledWith({}, expect.objectContaining({ userId: "admin-a" }), "deal-1", {
        decision: "DECLINE", reasons: ["Gearing above policy"], exceptionReason: null, exceptionsShown: null,
      })
    })
  })
})
