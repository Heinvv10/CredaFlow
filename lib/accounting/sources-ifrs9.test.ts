import { describe, expect, it } from "vitest"
import { deriveEntries, type PostedLedger } from "./derive"
import { resolveAccountMap } from "./accounts"
import { parsePeriodKey } from "./period"
import { ifrs9Sources, type Ifrs9Position } from "./sources-ifrs9"

const position = (over: Partial<Ifrs9Position> = {}): Ifrs9Position => ({
  loanId: "l1", reference: "L-1", runDate: new Date("2026-10-30T22:00:00.000Z"), eclCents: 316_800, suspendedInterestCents: 40_000,
  suspendedDefaultInterestCents: 4_000, journalsSuspense: true, writtenOff: false, closed: false, ...over,
})
const asOf = new Date("2026-10-31T22:00:00.000Z")
const byKey = (positions: Ifrs9Position[]) => Object.fromEntries(ifrs9Sources(positions, asOf).map((s) => [s.baseKey, s.vector]))

describe("ifrs9Sources", () => {
  it("provisions the run's ECL and holds its suspended interest out of income", () => {
    const v = byKey([position()])
    expect(v["ifrs9:ecl:l1"]).toEqual({ ECL_EXPENSE: 316_800, ECL_ALLOWANCE: -316_800 })
    // contractual 40 000 back out of INTEREST_INCOME, default interest 4 000 out of DEFAULT_INTEREST_INCOME
    expect(v["ifrs9:suspense:l1"]).toEqual({ INTEREST_INCOME: 40_000, DEFAULT_INTEREST_INCOME: 4_000, INTEREST_SUSPENSE: -44_000 })
  })

  it("releases both once the loan is closed", () => {
    expect(byKey([position({ closed: true })])).toEqual({ "ifrs9:ecl:l1": {}, "ifrs9:suspense:l1": {} })
  })

  it("on write-off drops the provision and sends the suspended interest to reduce the bad debt, not to income", () => {
    const v = byKey([position({ writtenOff: true })])
    expect(v["ifrs9:ecl:l1"]).toEqual({})
    expect(v["ifrs9:suspense:l1"]).toEqual({ INTEREST_INCOME: 40_000, DEFAULT_INTEREST_INCOME: 4_000, BAD_DEBT_EXPENSE: -44_000 })
  })

  it("journals no suspense for a contract type that does not support it, but still provisions", () => {
    const v = byKey([position({ journalsSuspense: false })])
    expect(v["ifrs9:suspense:l1"]).toEqual({})
    expect(v["ifrs9:ecl:l1"]).toEqual({ ECL_EXPENSE: 316_800, ECL_ALLOWANCE: -316_800 })
  })

  it("posts nothing for a run dated after the period", () => {
    expect(byKey([position({ runDate: new Date("2026-11-02T10:00:00.000Z") })])).toEqual({ "ifrs9:ecl:l1": {}, "ifrs9:suspense:l1": {} })
  })

  it("every vector sums to zero", () => {
    for (const p of [position(), position({ writtenOff: true }), position({ closed: true })]) {
      for (const source of ifrs9Sources([p], asOf)) expect(Object.values(source.vector).reduce((a, b) => a + b, 0)).toBe(0)
    }
  })
})

describe("through derive.ts month by month", () => {
  const accounts = resolveAccountMap([])
  const oct = parsePeriodKey("2026-10")!
  const nov = parsePeriodKey("2026-11")!
  const derive = (period: typeof oct, positions: Ifrs9Position[], posted: PostedLedger, postedKeys: Set<string>) =>
    deriveEntries({ loans: [], period, posted, postedKeys, postedLoans: new Map(), accounts, extraSources: ifrs9Sources(positions, period.end) })

  it("posts the allowance in the first month and only the movement the next", () => {
    const first = derive(oct, [position({ eclCents: 100_000, suspendedInterestCents: 0, suspendedDefaultInterestCents: 0 })], new Map(), new Set())
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ eventKey: "ifrs9:ecl:l1", eventType: "ECL_PROVISION", loanId: "l1", postingDate: "2026-10-31" })
    expect(first[0].lines.map((l) => [l.role, l.debitCents, l.creditCents, l.accountCode])).toEqual([
      ["ECL_EXPENSE", 100_000, 0, "6020"], ["ECL_ALLOWANCE", 0, 100_000, "1190"],
    ])

    const posted: PostedLedger = new Map([["ifrs9:ecl:l1", { ECL_EXPENSE: 100_000, ECL_ALLOWANCE: -100_000 }]])
    const second = derive(nov, [position({ eclCents: 130_000, runDate: new Date("2026-11-29T22:00:00.000Z"), suspendedInterestCents: 0, suspendedDefaultInterestCents: 0 })], posted, new Set(["ifrs9:ecl:l1"]))
    expect(second).toHaveLength(1)
    expect(second[0].eventKey).toBe("ifrs9:ecl:l1@2026-11")
    // movement of R300.00: 130 000 - 100 000
    expect(second[0].lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([["ECL_EXPENSE", 30_000, 0], ["ECL_ALLOWANCE", 0, 30_000]])
  })

  it("posts nothing when the position has not changed", () => {
    const posted: PostedLedger = new Map([["ifrs9:ecl:l1", { ECL_EXPENSE: 100_000, ECL_ALLOWANCE: -100_000 }]])
    expect(derive(nov, [position({ eclCents: 100_000, suspendedInterestCents: 0, suspendedDefaultInterestCents: 0 })], posted, new Set(["ifrs9:ecl:l1"]))).toEqual([])
  })

  it("reverses the suspense into income when the loan cures", () => {
    const posted: PostedLedger = new Map([["ifrs9:suspense:l1", { INTEREST_INCOME: 40_000, DEFAULT_INTEREST_INCOME: 4_000, INTEREST_SUSPENSE: -44_000 }]])
    const cured = derive(nov, [position({ eclCents: 0, suspendedInterestCents: 0, suspendedDefaultInterestCents: 0, runDate: new Date("2026-11-29T22:00:00.000Z") })], posted, new Set(["ifrs9:suspense:l1"]))
    expect(cured).toHaveLength(1)
    expect(cured[0].lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([
      ["INTEREST_SUSPENSE", 44_000, 0], ["INTEREST_INCOME", 0, 40_000], ["DEFAULT_INTEREST_INCOME", 0, 4_000],
    ])
  })
})
