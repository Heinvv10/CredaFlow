import { describe, expect, it } from "vitest"
import { deriveEntries, type PostedLedger } from "./derive"
import { resolveAccountMap } from "./accounts"
import { parsePeriodKey } from "./period"
import { ifrs9Sources, type Ifrs9Position } from "./sources-ifrs9"

const oct = parsePeriodKey("2026-10")!
const nov = parsePeriodKey("2026-11")!
const position = (over: Partial<Ifrs9Position> = {}): Ifrs9Position => ({
  loanId: "l1", reference: "L-1", periodKey: "2026-10", eclCents: 316_800, suspendedInterestCents: 40_000,
  suspendedDefaultInterestCents: 4_000, netInterestAdjustmentCents: 0, netDefaultInterestAdjustmentCents: 0, journalsSuspense: true, writtenOff: false, closed: false, ...over,
})
const byKey = (positions: Ifrs9Position[], period = oct) => Object.fromEntries(ifrs9Sources(positions, period).map((s) => [s.baseKey, s.vector]))

describe("ifrs9Sources", () => {
  it("provisions the run's ECL and holds its suspended interest out of income", () => {
    const v = byKey([position()])
    expect(v["ifrs9:ecl:l1"]).toEqual({ ECL_EXPENSE: 316_800, ECL_ALLOWANCE: -316_800 })
    // contractual 40 000 back out of INTEREST_INCOME, default interest 4 000 out of DEFAULT_INTEREST_INCOME
    expect(v["ifrs9:suspense:l1"]).toEqual({ INTEREST_INCOME: 40_000, DEFAULT_INTEREST_INCOME: 4_000, INTEREST_SUSPENSE: -44_000 })
  })

  it("releases both once the loan is closed", () => {
    expect(byKey([position({ closed: true })])).toEqual({ "ifrs9:ecl:l1": {}, "ifrs9:suspense:l1": {}, "ifrs9:netint:l1": {} })
  })

  it("on write-off uses the allowance against the bad debt: ECL_EXPENSE stays charged, nothing is credited to the expense", () => {
    const v = byKey([position({ writtenOff: true })])
    expect(v["ifrs9:ecl:l1"]).toEqual({ ECL_EXPENSE: 316_800, BAD_DEBT_EXPENSE: -316_800 })
    expect(v["ifrs9:suspense:l1"]).toEqual({ INTEREST_INCOME: 40_000, DEFAULT_INTEREST_INCOME: 4_000, BAD_DEBT_EXPENSE: -44_000 })
  })

  it("journals no suspense for a contract type that does not support it, but still provisions", () => {
    const v = byKey([position({ journalsSuspense: false })])
    expect(v["ifrs9:suspense:l1"]).toEqual({})
    expect(v["ifrs9:ecl:l1"]).toEqual({ ECL_EXPENSE: 316_800, ECL_ALLOWANCE: -316_800 })
  })

  it("posts nothing for a run of a month after the period", () => {
    expect(byKey([position({ periodKey: "2026-11" })])).toEqual({ "ifrs9:ecl:l1": {}, "ifrs9:suspense:l1": {}, "ifrs9:netint:l1": {} })
  })

  it("net basis: income and the ECL expense both fall by the cumulative adjustment; no suspense, and none of it given back", () => {
    const net = { suspendedInterestCents: 0, suspendedDefaultInterestCents: 0, netInterestAdjustmentCents: 6_000, netDefaultInterestAdjustmentCents: 2_400 }
    for (const over of [{}, { writtenOff: true }, { closed: true }]) {
      expect(byKey([position({ ...net, ...over })])["ifrs9:netint:l1"]).toEqual({ INTEREST_INCOME: 6_000, DEFAULT_INTEREST_INCOME: 2_400, ECL_EXPENSE: -8_400 })
    }
    expect(byKey([position(net)])["ifrs9:suspense:l1"]).toEqual({})
  })

  it("every vector sums to zero", () => {
    for (const p of [position(), position({ writtenOff: true }), position({ closed: true }), position({ netInterestAdjustmentCents: 6_000, netDefaultInterestAdjustmentCents: 2_400 })]) {
      for (const source of ifrs9Sources([p], oct)) expect(Object.values(source.vector).reduce((a, b) => a + b, 0)).toBe(0)
    }
  })
})

describe("through derive.ts month by month", () => {
  const accounts = resolveAccountMap([])
  const derive = (period: typeof oct, positions: Ifrs9Position[], posted: PostedLedger) =>
    deriveEntries({ loans: [], period, posted, postedKeys: new Set(posted.keys()), postedLoans: new Map(), accounts, extraSources: ifrs9Sources(positions, period) })
  const net = (entries: ReturnType<typeof derive>, role: string) =>
    entries.flatMap((e) => e.lines).filter((l) => l.role === role).reduce((s, l) => s + l.debitCents - l.creditCents, 0)
  const noSuspense = { suspendedInterestCents: 0, suspendedDefaultInterestCents: 0 }

  it("posts the allowance on the month's last day in the first month and only the movement the next", () => {
    const first = derive(oct, [position({ eclCents: 100_000, ...noSuspense })], new Map())
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ eventKey: "ifrs9:ecl:l1", eventType: "ECL_PROVISION", loanId: "l1", postingDate: "2026-10-31" })
    expect(first[0].lines.map((l) => [l.role, l.debitCents, l.creditCents, l.accountCode])).toEqual([
      ["ECL_EXPENSE", 100_000, 0, "6020"], ["ECL_ALLOWANCE", 0, 100_000, "1190"],
    ])

    const posted: PostedLedger = new Map([["ifrs9:ecl:l1", { ECL_EXPENSE: 100_000, ECL_ALLOWANCE: -100_000 }]])
    const second = derive(nov, [position({ periodKey: "2026-11", eclCents: 130_000, ...noSuspense })], posted)
    expect(second).toHaveLength(1)
    expect(second[0].eventKey).toBe("ifrs9:ecl:l1@2026-11")
    // movement of R300.00: 130 000 - 100 000
    expect(second[0].lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([["ECL_EXPENSE", 30_000, 0], ["ECL_ALLOWANCE", 0, 30_000]])
  })

  it("posts nothing when the position has not changed", () => {
    const posted: PostedLedger = new Map([["ifrs9:ecl:l1", { ECL_EXPENSE: 100_000, ECL_ALLOWANCE: -100_000 }]])
    expect(derive(nov, [position({ periodKey: "2026-11", eclCents: 100_000, ...noSuspense })], posted)).toEqual([])
  })

  it("reverses the suspense into income when the loan cures", () => {
    const posted: PostedLedger = new Map([["ifrs9:suspense:l1", { INTEREST_INCOME: 40_000, DEFAULT_INTEREST_INCOME: 4_000, INTEREST_SUSPENSE: -44_000 }]])
    const cured = derive(nov, [position({ periodKey: "2026-11", eclCents: 0, ...noSuspense })], posted)
    expect(cured).toHaveLength(1)
    expect(cured[0].lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([
      ["INTEREST_SUSPENSE", 44_000, 0], ["INTEREST_INCOME", 0, 40_000], ["DEFAULT_INTEREST_INCOME", 0, 4_000],
    ])
  })

  it("net basis month by month: the allowance is the ECL on the gross exposure, the expense is lower by the interest taken off", () => {
    const stage3 = { eclCents: 142_140, suspendedInterestCents: 0, suspendedDefaultInterestCents: 0, netInterestAdjustmentCents: 6_000 }
    const entries = derive(nov, [position({ periodKey: "2026-11", ...stage3 })], new Map())
    expect(net(entries, "ECL_ALLOWANCE")).toBe(-142_140)
    expect(net(entries, "ECL_EXPENSE")).toBe(142_140 - 6_000)
    expect(net(entries, "INTEREST_INCOME")).toBe(6_000)
    expect(net(entries, "INTEREST_SUSPENSE")).toBe(0)
    // a later cured month adds nothing to the adjustment, and so gives nothing back
    const posted: PostedLedger = new Map([
      ["ifrs9:ecl:l1", { ECL_EXPENSE: 142_140, ECL_ALLOWANCE: -142_140 }],
      ["ifrs9:netint:l1", { INTEREST_INCOME: 6_000, ECL_EXPENSE: -6_000 }],
    ])
    const dec = parsePeriodKey("2026-12")!
    const cured = deriveEntries({ loans: [], period: dec, posted, postedKeys: new Set(posted.keys()), postedLoans: new Map(), accounts, extraSources: ifrs9Sources([position({ periodKey: "2026-12", eclCents: 60_000, suspendedInterestCents: 0, suspendedDefaultInterestCents: 0, netInterestAdjustmentCents: 6_000 })], dec) })
    expect(net(cured, "INTEREST_INCOME")).toBe(0)
    expect(net(cured, "ECL_ALLOWANCE")).toBe(82_140)
  })

  // Review breaker 1a (PR #255): a month's run made late (days 1-5 of the next month, or by an administrator) used to be
  // dated its make-up day, after the period, so it posted nothing and reversed the allowance already held.
  it("a late or superseding run for October is October's position: it moves the allowance, it does not reverse it", () => {
    const posted: PostedLedger = new Map([
      ["ifrs9:ecl:l1", { ECL_EXPENSE: 100_000, ECL_ALLOWANCE: -100_000 }],
      ["ifrs9:suspense:l1", { INTEREST_INCOME: 40_000, INTEREST_SUSPENSE: -40_000 }],
    ])
    const entries = derive(oct, [position({ periodKey: "2026-10", eclCents: 150_000, suspendedInterestCents: 40_000, suspendedDefaultInterestCents: 0 })], posted)
    expect(net(entries, "ECL_ALLOWANCE")).toBe(-50_000)
    expect(net(entries, "INTEREST_SUSPENSE")).toBe(0)
  })

  // Review breaker 2 (PR #255): the write-off used to release the allowance to P&L (Cr ECL_EXPENSE) instead of using it.
  it("write-off debits the allowance and credits the bad debt, with no credit to ECL_EXPENSE", () => {
    const posted: PostedLedger = new Map([["ifrs9:ecl:l1", { ECL_EXPENSE: 100_000, ECL_ALLOWANCE: -100_000 }]])
    const entries = derive(oct, [position({ eclCents: 100_000, writtenOff: true, ...noSuspense })], posted)
    expect(net(entries, "ECL_EXPENSE")).toBe(0)
    expect(net(entries, "ECL_ALLOWANCE")).toBe(100_000)
    expect(net(entries, "BAD_DEBT_EXPENSE")).toBe(-100_000)
  })

  // Review breaker 3 (PR #255): an asset-finance contract's interest stays in income and the receivable, so none of it may be
  // taken out of exposure as "suspended" (lib/ifrs9/snapshot.test.ts holds the exposure side).
  it("an asset-finance contract posts the provision and no suspense", () => {
    const v = byKey([position({ loanId: "af", journalsSuspense: false, suspendedInterestCents: 0, suspendedDefaultInterestCents: 0 })])
    expect(v["ifrs9:suspense:af"]).toEqual({})
    expect(v["ifrs9:ecl:af"]).toEqual({ ECL_EXPENSE: 316_800, ECL_ALLOWANCE: -316_800 })
  })
})
