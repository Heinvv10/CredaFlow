import { Prisma } from "@prisma/client"
import { describe, expect, it, vi } from "vitest"
import { approvalInterestCapCheck, capRepoRate, checkNcaInterestRateFor, earlierShortTermCreditThisYear } from "./nca-interest-cap.server"

const dec = (rate: string) => new Prisma.Decimal(rate)
function db(approved: string | null, fed: string[] = []) {
  return {
    referenceRate: {
      findFirst: vi.fn(async () => (approved ? { effectiveDate: new Date("2026-05-29T00:00:00Z"), rate: dec(approved) } : null)),
      findMany: vi.fn(async () => fed.map((rate) => ({ rate: dec(rate) }))),
    },
  } as never
}
const unsecured = { creditType: "UNSECURED" as const, interestRatePm: 0.0233, interestModel: "REDUCING_BALANCE" }
const on = new Date("2026-11-25T10:00:00+02:00")

describe("the repo rate the NCA cap uses", () => {
  it("is the approved value when the feed has nothing newer", async () => {
    expect(await capRepoRate(db("0.0725"), "t1", "2026-11-25")).toEqual({ rate: 0.0725, approved: 0.0725 })
  })

  it("is a newer fed value still awaiting approval when it is lower: an unapproved cut lowers the cap at once", async () => {
    expect(await capRepoRate(db("0.0725", ["0.07"]), "t1", "2026-11-25")).toEqual({ rate: 0.07, approved: 0.0725 })
    // 2.33% a month (27.96%) passes at 7.25% (cap 28.25%) and fails at 7% (28%).
    expect(await checkNcaInterestRateFor(db("0.0725"), "t1", unsecured, on)).toEqual({ ok: true })
    expect(await checkNcaInterestRateFor(db("0.0725", ["0.07"]), "t1", unsecured, on)).toEqual({ ok: true })
    expect(await checkNcaInterestRateFor(db("0.0725", ["0.0675"]), "t1", unsecured, on)).toMatchObject({ ok: false, reason: "ABOVE_CAP" })
  })

  it("ignores a fed value outside the plausible 1%–20% band rather than lower the cap on it", async () => {
    expect(await capRepoRate(db("0.0725", ["0.002", "0.07"]), "t1", "2026-11-25")).toEqual({ rate: 0.07, approved: 0.0725 })
    expect(await capRepoRate(db("0.0725", ["0.002"]), "t1", "2026-11-25")).toEqual({ rate: 0.0725, approved: 0.0725 })
  })

  it("ignores a newer fed value that is higher until a person approves it", async () => {
    expect(await capRepoRate(db("0.07", ["0.0775"]), "t1", "2026-11-25")).toEqual({ rate: 0.07, approved: 0.07 })
  })

  it("asks only for SARB-fed PENDING or REJECTED repo values dated after the approved one", async () => {
    const d = db("0.07")
    await capRepoRate(d, "t1", "2026-11-25")
    expect((d as unknown as { referenceRate: { findMany: ReturnType<typeof vi.fn> } }).referenceRate.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ tenantId: "t1", basis: "REPO", source: "SARB_FEED", status: { in: ["PENDING", "REJECTED"] }, effectiveDate: expect.objectContaining({ gt: new Date("2026-05-29T00:00:00Z") }) }),
      select: { rate: true },
    })
  })

  it("refuses to price from an approved repo rate outside 1%–20%", async () => {
    expect(await checkNcaInterestRateFor(db("0.35"), "t1", unsecured, on)).toMatchObject({ ok: false, reason: "REPO_IMPLAUSIBLE" })
    expect(await checkNcaInterestRateFor(db("0.005"), "t1", unsecured, on)).toMatchObject({ ok: false, reason: "REPO_IMPLAUSIBLE" })
  })

  it("points at the page every lender can open", async () => {
    const result = await checkNcaInterestRateFor(db(null), "t1", unsecured, on)
    expect(result).toMatchObject({ ok: false, reason: "NO_REPO_RATE" })
    expect(!result.ok && result.message).toContain("Settings → Repo rate")
  })
})

describe("the client's earlier short-term credit this calendar year", () => {
  const yearStart = new Date("2026-01-01T00:00:00+02:00")
  function credit(loans: Array<[string, string]>, approved: Array<[number, number]>) {
    return {
      loan: { findMany: vi.fn(async () => loans.map(([start, end]) => ({ startDate: new Date(start), maturityDate: new Date(end) }))) },
      loanApplication: {
        findMany: vi.fn(async () => approved.map(([amount, days]) => ({ appliedAmount: amount, appliedTermDays: days, approvedAmount: amount, approvedTermDays: days }))),
      },
    }
  }

  it("counts short-term loans paid out and short-term applications approved, not yet paid out", async () => {
    const db = credit(
      [["2026-03-01T10:00:00Z", "2026-03-31T10:00:00Z"], ["2026-02-01T10:00:00Z", "2026-12-01T10:00:00Z"]],
      [[200_000, 30], [900_000, 30]],
    )
    expect(await earlierShortTermCreditThisYear(db as never, "t1", "c1", on, { id: "app-1" })).toBe(2)
  })

  it("asks for this year's credit, CANCELLED loans and the subject itself left out, ordered by approval", async () => {
    const db = credit([], [])
    await earlierShortTermCreditThisYear(db as never, "t1", "c1", on, { id: "app-1" })
    expect(db.loan.findMany.mock.calls[0]).toEqual([expect.objectContaining({
      where: {
        tenantId: "t1", clientId: "c1", status: { not: "CANCELLED" }, applicationId: { not: "app-1" },
        startDate: { gte: yearStart, lte: on }, principal: { lte: 800_000 },
        OR: [{ application: { approvedAt: { lt: on } } }, { application: { approvedAt: null } }],
      },
    })])
    expect(db.loanApplication.findMany.mock.calls[0]).toEqual([expect.objectContaining({
      where: { tenantId: "t1", clientId: "c1", status: "APPROVED", loan: null, id: { not: "app-1" }, approvedAt: { gte: yearStart, lt: on } },
    })])
  })

  it("at payout, counts only credit approved before the subject was", async () => {
    const db = credit([], [])
    const approvedAt = new Date("2026-11-20T09:00:00+02:00")
    await earlierShortTermCreditThisYear(db as never, "t1", "c1", on, { id: "app-1", approvedAt })
    expect(db.loanApplication.findMany.mock.calls[0]).toEqual([expect.objectContaining({
      where: expect.objectContaining({ approvedAt: { gte: yearStart, lt: approvedAt } }),
    })])
  })
})

// Fair Score acceptance (2026-10-17): the application page needs the verdict /decide
// answers with, not a client-side guess, to list it as a blocker.
describe("approvalInterestCapCheck: the verdict the application page lists as a blocker", () => {
  const application = (interestRatePm: number, overrides: Record<string, unknown> = {}) => ({
    id: "app-1", approvedAt: null, ncaRegime: "NCA", clientId: "c1",
    appliedAmount: 5_000_000, appliedTermDays: 360,
    product: { interestRatePm, interestModel: "REDUCING_BALANCE" },
    ...overrides,
  })

  it("fails a product rate above the cap, naming the maximum", async () => {
    // 3% a month = 36% a year; repo 8.25% + 21% caps it at 29.25%.
    const result = await approvalInterestCapCheck(db("0.0825"), "t1", application(0.03), on)
    expect(result).toMatchObject({ ok: false, reason: "ABOVE_CAP" })
    expect(!result.ok && result.message).toContain("exceeds the NCA maximum of 29.25%")
  })

  it("passes a rate within the cap", async () => {
    expect(await approvalInterestCapCheck(db("0.0825"), "t1", application(0.0233), on)).toEqual({ ok: true })
  })

  it("does not apply Regulation 42 to a NON_NCA agreement", async () => {
    expect(await approvalInterestCapCheck(db("0.0825"), "t1", application(0.03, { ncaRegime: "NON_NCA" }), on)).toEqual({ ok: true })
  })
})
