import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import type { RegimeTx } from "./classification"
import { decideDeal, parseDecideInput } from "./deal-decision"

const REASONS = ["Strong DSCR on audited AFS"]
const actor = { tenantId: "tenant-1", userId: "admin-a", userEmail: "a@lender.test" }

function fakeTx(deal: Record<string, unknown> | null, pendingOverride = false) {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "app-1" }]),
    assetFinanceDeal: {
      findFirst: vi.fn(async () => deal),
      update: vi.fn(async () => ({})),
    },
    ncaRegimeOverride: { findFirst: vi.fn(async () => (pendingOverride ? { id: "ovr-1" } : null)) },
    loanApplication: { update: vi.fn(async () => ({})) },
    auditLog: { create: vi.fn(async () => ({})) },
  }
  return { tx, asTx: tx as unknown as RegimeTx }
}

const deal = (over: { status?: string; appStatus?: string; ncaRegime?: string; memo?: boolean; assessment?: boolean | null } = {}) => ({
  id: "deal-1",
  applicationId: "app-1",
  status: over.status ?? "SUBMITTED",
  financials: over.memo === false ? null : { dscr: new Prisma.Decimal("1.8"), gearing: new Prisma.Decimal("0.25") },
  affordabilityAssessment: over.assessment === null ? null : { affordable: over.assessment ?? true },
  application: {
    status: over.appStatus ?? "SUBMITTED",
    ncaRegime: over.ncaRegime ?? "NON_NCA",
    ncaClassificationRule: "JURISTIC_OVER_THRESHOLD",
    appliedAmount: 155_250_000,
    appliedTermDays: 1826,
  },
})

describe("parseDecideInput: reasons are mandatory for every decision", () => {
  it.each([
    [{ decision: "APPROVE" }, /reasons/],
    [{ decision: "DECLINE", reasons: [] }, /reasons/],
    [{ decision: "REFER", reasons: ["abcd"] }, /5 to/],
    [{ decision: "APPROVE", reasons: ["   long enough   ", "  no "] }, /5 to/],
    [{ decision: "APPROVE", reasons: [42] }, /5 to/],
    [{ decision: "MAYBE", reasons: REASONS }, /decision/],
    [null, /JSON object/],
  ])("refuses %j", (body, message) => {
    expect(parseDecideInput(body)).toMatch(message)
  })

  it("trims each reason", () => {
    expect(parseDecideInput({ decision: "DECLINE", reasons: ["  Gearing too high  "] })).toEqual({
      decision: "DECLINE",
      reasons: ["Gearing too high"],
    })
  })
})

describe("decideDeal", () => {
  let fake: ReturnType<typeof fakeTx>
  beforeEach(() => vi.clearAllMocks())

  it("APPROVE without a credit memo is refused and writes nothing", async () => {
    fake = fakeTx(deal({ memo: false }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "memo_required" })
    expect(fake.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(fake.tx.assetFinanceDeal.update).not.toHaveBeenCalled()
  })

  it("APPROVE on an NCA application with a pending override waits for the second approver, writing nothing", async () => {
    fake = fakeTx(deal({ ncaRegime: "NCA" }), true)
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "awaiting_override" })
    expect(fake.tx.loanApplication.update).not.toHaveBeenCalled()
    expect(fake.tx.auditLog.create).not.toHaveBeenCalled()
  })

  it("APPROVE on an NCA application requires an affordable recorded s81 assessment", async () => {
    fake = fakeTx(deal({ ncaRegime: "NCA", assessment: null }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "assessment_required" })
    fake = fakeTx(deal({ ncaRegime: "NCA", assessment: false }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "unaffordable" })
    fake = fakeTx(deal({ ncaRegime: "NCA", assessment: true }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toMatchObject({ kind: "decided", status: "APPROVED" })
  })

  it("APPROVE moves the application SUBMITTED → UNDER_REVIEW → APPROVED (EFT, approver) and audits the reasons", async () => {
    fake = fakeTx(deal())
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "APPROVE", reasons: REASONS })).toEqual({ kind: "decided", status: "APPROVED" })
    const updates = fake.tx.loanApplication.update.mock.calls.map((call) => (call as unknown as [{ data: { status: string } }])[0].data)
    expect(updates[0]).toEqual({ status: "UNDER_REVIEW" })
    expect(updates[1]).toMatchObject({
      status: "APPROVED", repaymentMethod: "EFT", approvedById: "admin-a", approvedAmount: 155_250_000, approvedTermDays: 1826,
    })
    expect(fake.tx.assetFinanceDeal.update).toHaveBeenCalledWith({
      where: { id: "deal-1", tenantId: "tenant-1" },
      data: expect.objectContaining({ status: "APPROVED", decision: "APPROVE", decisionReasons: REASONS, decidedById: "admin-a" }),
    })
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "ASSET_DEAL_DECIDED", newValue: expect.objectContaining({ reasons: REASONS, dscr: "1.8000" }) }),
    })
  })

  it("DECLINE needs no memo and no NON_NCA; REFER leaves the application UNDER_REVIEW", async () => {
    fake = fakeTx(deal({ ncaRegime: "NCA", memo: false }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "DECLINE", reasons: REASONS })).toEqual({ kind: "decided", status: "DECLINED" })
    expect(fake.tx.loanApplication.update).toHaveBeenCalledWith({
      where: { id: "app-1", tenantId: "tenant-1" }, data: { status: "DECLINED", decisionReason: REASONS[0] },
    })

    fake = fakeTx(deal({ ncaRegime: "NCA", memo: false }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "REFER", reasons: REASONS })).toEqual({ kind: "decided", status: "REFERRED" })
    expect(fake.tx.loanApplication.update).toHaveBeenCalledTimes(1)
    expect(fake.tx.loanApplication.update).toHaveBeenCalledWith({ where: { id: "app-1", tenantId: "tenant-1" }, data: { status: "UNDER_REVIEW" } })
  })

  it.each(["DRAFT", "APPROVED", "DECLINED", "REFUSED_NCA"])("a %s deal is not decidable", async (status) => {
    fake = fakeTx(deal({ status }))
    expect(await decideDeal(fake.asTx, actor, "deal-1", { decision: "DECLINE", reasons: REASONS })).toEqual({ kind: "not_decidable", status })
    expect(fake.tx.assetFinanceDeal.update).not.toHaveBeenCalled()
  })

  it("is not_found when the deal is not the tenant's", async () => {
    fake = fakeTx(null)
    expect(await decideDeal(fake.asTx, actor, "deal-x", { decision: "DECLINE", reasons: REASONS })).toEqual({ kind: "not_found" })
  })
})
