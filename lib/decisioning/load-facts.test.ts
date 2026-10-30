import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/affordability/own-lender-debt-load", () => ({ liveOwnAwareDebtInputs: async () => ({ application: [], client: [] }) }))

import { loadDecisionFacts } from "./load-facts"

const NOW = new Date("2026-10-29T08:00:00Z")
const state = { productType: "MICRO", deal: null as { id: string } | null, bureau: null as Record<string, unknown> | null, submittedByClient: false, loans: [] as { status: string }[], snapshot: undefined as unknown }

function application() {
  return {
    id: "a1", tenantId: "t", clientId: "c1", productId: "p1", status: "UNDER_REVIEW", updatedAt: new Date("2026-10-29T07:00:00Z"), submittedAt: new Date("2026-10-29T07:59:00Z"),
    appliedAmount: 300_000, appliedTermDays: 30, initiationFeePayment: "DEFERRED", bureauReviewGeneration: "gen1",
    affordabilityResult: state.snapshot ?? null,
    assetFinanceDeal: state.deal,
    product: { code: "MICRO", productType: state.productType, interestRatePm: 0.05, interestModel: "FLAT", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900 },
    client: {
      id: "c1", dateOfBirth: new Date("1990-10-30T00:00:00Z"), employmentStatus: "EMPLOYED", incomeSourceType: "SALARY", employmentStartDate: new Date("2020-09-01T00:00:00Z"),
      monthlyIncome: 2_000_000, monthlyExpenses: 800_000, grossMonthlyIncome: 2_200_000, expenseBreakdown: null, debtObligations: [],
    },
  }
}
const db = {
  loanApplication: { findFirst: vi.fn(async () => application()) },
  tenantConfig: { findFirst: vi.fn(async () => ({ bureauMaxAgeDays: 60, ndiBufferPct: 110 })) },
  creditBureauCheck: { findFirst: vi.fn(async () => state.bureau) },
  auditLog: { findFirst: vi.fn(async () => (state.submittedByClient ? { id: "x" } : null)) },
  loan: { findMany: vi.fn(async () => state.loans) },
}
const load = (options = {}) => loadDecisionFacts(db as never, "t", "a1", NOW, options)

beforeEach(() => { state.productType = "MICRO"; state.deal = null; state.bureau = null; state.submittedByClient = false; state.loans = []; state.snapshot = undefined })

describe("loadDecisionFacts", () => {
  it("is not for asset finance: neither an asset-finance product nor an application that carries a deal is a consumer application", async () => {
    state.productType = "ASSET_FINANCE"
    expect(await load()).toBeNull()
    state.productType = "MICRO"
    state.deal = { id: "deal-1" }
    expect(await load()).toBeNull()
  })

  it("bureau flags are missing, not false, when there is no current bureau check", async () => {
    const { facts, bureauCheckId } = (await load())!
    expect(facts).toMatchObject({ bureauAvailable: false, bureauScore: null, bureauJudgement: null, bureauAdverse: null, bureauNotice: null, bureauUnderDebtReview: null, bureauDeceased: null, bureauUnscoreable: null })
    expect(bureauCheckId).toBeNull()
  })

  it("reads the flags and score of the current check", async () => {
    state.bureau = { id: "b1", score: 640, unscoreable: false, hasAdverse: false, hasJudgement: true, hasNotice: false, underDebtReview: false, deceased: false, obligations: { totalMonthly: 0 } }
    const { facts, bureauCheckId } = (await load())!
    expect(facts).toMatchObject({ bureauAvailable: true, bureauScore: 640, bureauJudgement: true, bureauAdverse: false })
    expect(bureauCheckId).toBe("b1")
  })

  it("an unscoreable check has no score", async () => {
    state.bureau = { id: "b1", score: 500, unscoreable: true, hasAdverse: false, hasJudgement: false, hasNotice: false, underDebtReview: false, deceased: false, obligations: { totalMonthly: 0 } }
    expect((await load())!.facts).toMatchObject({ bureauScore: null, bureauUnscoreable: true })
  })

  it("the channel is PORTAL when the client submitted it, STAFF otherwise", async () => {
    expect((await load())!.facts.channel).toBe("STAFF")
    state.submittedByClient = true
    expect((await load())!.facts.channel).toBe("PORTAL")
  })

  it("age and employment months are whole, as at the decision day (birthday not yet reached)", async () => {
    const { facts } = (await load())!
    expect(facts.ageYears).toBe(35)
    expect(facts.employmentMonths).toBe(73)
  })

  it("repeat client and open loans come from the lender's own book", async () => {
    state.loans = [{ status: "ACTIVE" }, { status: "COMPLETED" }]
    expect((await load())!.facts).toMatchObject({ isRepeatClient: true, openLoansCount: 1 })
  })

  it("affordability is the approval gate's own: unrounded cover, debt as the higher of declared and bureau, and its verdict", async () => {
    state.bureau = { id: "b1", score: 640, unscoreable: false, hasAdverse: false, hasJudgement: false, hasNotice: false, underDebtReview: false, deceased: false, obligations: { totalMonthly: 300_000 } }
    const { facts } = (await load())!
    expect(facts.monthlyDebtCents).toBe(300_000)
    expect(facts.ndiCents).toBe(900_000)
    expect(facts.instalmentCents).toBeGreaterThan(0)
    expect(facts.ndiCoverPct).toBeCloseTo((900_000 / facts.instalmentCents!) * 100, 8)
    expect(facts.affordabilityGatePasses).toBe(true)
    expect(facts.expensesBelowMinimum).toBe(false)
  })

  it("a simulation reads the recorded submission snapshot instead of today's figures", async () => {
    const { createSubmissionAffordabilitySnapshot, withAffordabilitySnapshot } = await import("@/lib/affordability/snapshot")
    const app = application()
    const snapshot = createSubmissionAffordabilitySnapshot({
      capturedAt: app.submittedAt, capturedById: "u", client: { ...app.client, expenseBreakdown: null }, applicationDebts: [], clientDebts: [],
      application: { appliedAmount: 300_000, appliedTermDays: 30, productId: "p1", initiationFeePayment: "DEFERRED" },
      product: { interestRatePm: 0.05, interestModel: "FLAT", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900, productType: "MICRO" },
    } as never)
    state.snapshot = withAffordabilitySnapshot(null, snapshot)
    const live = (await load())!
    const replay = (await load({ preferSnapshot: true }))!
    expect(live.affordabilitySource).toBe("LIVE")
    expect(replay.affordabilitySource).toBe("SNAPSHOT")
    expect(replay.facts.ndiCents).toBe(snapshot.outcome.netDisposableIncomeCents)
    expect(replay.facts.instalmentCents).toBe(snapshot.outcome.netDisposableIncomeCents - snapshot.outcome.ndiAfterLoanCents)
  })

  it("has no snapshot to prefer on an application that carries none", async () => {
    expect((await load({ preferSnapshot: true }))!.affordabilitySource).toBe("LIVE")
  })

  it("is null for an application with no client borrower", async () => {
    db.loanApplication.findFirst.mockResolvedValueOnce({ ...application(), client: null as never })
    expect(await load()).toBeNull()
  })
})
