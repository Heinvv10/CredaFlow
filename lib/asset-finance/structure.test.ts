import { describe, expect, it } from "vitest"
import { solveStructure } from "./structure"
import { annualSeasonal, biannual, monthly, skipN, stepUp } from "./structure-presets"
import type { StructureInput } from "./types"
import { expectLedgerInvariants, expectMatchesOracle } from "./__tests__/oracle-assertions"

// Synthetic deal: R1 250 000 machine, 10% deposit, R1 500 financed fees, 11.75%.
const BASE: Omit<StructureInput, "weights"> = {
  cashPriceCents: 125_000_000,
  depositCents: 12_500_000,
  tradeInCents: 0,
  financedFeesCents: 150_000,
  balloonCents: 0,
  startDate: "2026-01-15",
  ratePath: [{ effectiveDate: "2026-01-15", annualRate: 0.1175 }],
}

const PRESET_CASES: { name: string; input: StructureInput }[] = [
  { name: "monthly 60", input: { ...BASE, weights: monthly(60) } },
  {
    // 31 Jan start: due dates 28 Feb, 31 Mar, 30 Apr ... (anchored on the 31st).
    name: "annualSeasonal 60, Mar–May ×3, off ×0.5",
    input: { ...BASE, startDate: "2026-01-31", ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.1175 }], weights: annualSeasonal(60, 2, [3, 4, 5], 3, 0.5) },
  },
  {
    // First due 30 Oct 2026, so period 59 falls in September.
    name: "biannual 60, Mar + Sep",
    input: { ...BASE, startDate: "2026-09-30", ratePath: [{ effectiveDate: "2026-09-30", annualRate: 0.1175 }], weights: biannual(60, [3, 9], 10) },
  },
  { name: "skipN 60, skip 3", input: { ...BASE, weights: skipN(60, 3) } },
  {
    name: "stepUp 60",
    input: {
      ...BASE,
      weights: stepUp(60, [
        { fromPeriod: 0, weight: 0.6 },
        { fromPeriod: 12, weight: 0.8 },
        { fromPeriod: 24, weight: 1 },
        { fromPeriod: 36, weight: 1.25 },
      ]),
    },
  },
  { name: "monthly 60, 20% balloon", input: { ...BASE, balloonCents: 25_000_000, weights: monthly(60) } },
  {
    name: "monthly 60, mid-period rate changes",
    input: {
      ...BASE,
      ratePath: [
        { effectiveDate: "2026-01-15", annualRate: 0.1175 },
        { effectiveDate: "2027-03-27", annualRate: 0.12 },
        { effectiveDate: "2028-07-01", annualRate: 0.115 },
      ],
      weights: monthly(60),
    },
  },
  {
    name: "monthly 60, VAT deferred to period 2, explicit first due date",
    input: {
      ...BASE,
      firstDueDate: "2026-03-01",
      vatDeferralPeriods: { vatCents: 16_304_348, periodIndex: 2 },
      weights: monthly(60),
    },
  },
]

describe("solveStructure against the independent day-by-day oracle", () => {
  for (const { name, input } of PRESET_CASES) {
    it(name, () => {
      const result = solveStructure(input)
      expectLedgerInvariants(result, input.balloonCents)
      expectMatchesOracle(input, result)
    })
  }

  it("capitalises unpaid interest in skip periods", () => {
    const { rows } = solveStructure({ ...BASE, weights: skipN(60, 3) })
    for (const row of rows.slice(0, 3)) {
      expect(row.totalCents).toBe(0)
      expect(row.principalCents).toBe(-row.interestCents)
      expect(row.closingBalanceCents).toBe(row.openingBalanceCents + row.interestCents)
    }
  })

  it("anchors due dates on the original day and clamps to month end", () => {
    const { rows } = solveStructure(PRESET_CASES[1].input)
    expect(rows.slice(0, 4).map((r) => r.dueDate)).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"])
    expect(rows[24].dueDate).toBe("2028-02-29")
  })
})

describe("hand-computed case: R10 000 over 3 months at 12% fixed, no balloon", () => {
  // Start 2026-01-01; due 2026-02-01, 2026-03-01, 2026-04-01. Period lengths
  // 31, 28 (2026 is not a leap year), 31 days. Growth per period:
  //   g1 = 1 + 0.12 × 31/365 = 1.0101917808...
  //   g2 = 1 + 0.12 × 28/365 = 1.0092054794...
  //   g3 = g1
  // Real-valued B: 1 000 000 × g1 × g2 × g3 = B × (g2 × g3 + g3 + 1)
  //   → B = 339 930.467... → 339 930 cents.
  // Row 1: interest 1 000 000 × 0.12 × 31/365 = 10 191.78 → 10 192
  //        principal 339 930 − 10 192 = 329 738, closing 670 262
  // Row 2: interest   670 262 × 0.12 × 28/365 =  6 170.08 →  6 170
  //        principal 339 930 −  6 170 = 333 760, closing 336 502
  // Row 3: interest   336 502 × 0.12 × 31/365 =  3 429.55 →  3 430
  //        the last row absorbs the residue: pays 336 502 + 3 430 = 339 932
  //        (2 cents above B), principal 336 502, closing 0.
  const input: StructureInput = {
    cashPriceCents: 1_000_000,
    depositCents: 0,
    tradeInCents: 0,
    financedFeesCents: 0,
    balloonCents: 0,
    weights: [1, 1, 1],
    startDate: "2026-01-01",
    ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.12 }],
  }

  it("matches the working above", () => {
    const result = solveStructure(input)
    expect(result.financedAmountCents).toBe(1_000_000)
    expect(result.baseInstalmentCents).toBe(339_930)
    expect(result.rows.map((r) => [r.dueDate, r.openingBalanceCents, r.interestCents, r.principalCents, r.totalCents, r.closingBalanceCents])).toEqual([
      ["2026-02-01", 1_000_000, 10_192, 329_738, 339_930, 670_262],
      ["2026-03-01", 670_262, 6_170, 333_760, 339_930, 336_502],
      ["2026-04-01", 336_502, 3_430, 336_502, 339_932, 0],
    ])
    expect(result.totalInterestCents).toBe(19_792)
    expect(result.totalPayableCents).toBe(1_019_792)
  })
})

describe("solveStructure refuses invalid structures", () => {
  const ok: StructureInput = { ...BASE, weights: monthly(12) }
  const cases: [string, Partial<StructureInput>][] = [
    ["financed amount zero", { depositCents: 125_150_000 }],
    ["non-integer cents", { depositCents: 1.5 }],
    ["negative trade-in", { tradeInCents: -1 }],
    ["negative balloon", { balloonCents: -1 }],
    ["balloon equal to financed amount", { balloonCents: 112_650_000 }],
    ["empty weights", { weights: [] }],
    ["negative weight", { weights: [1, -1, 1] }],
    ["non-finite weight", { weights: [1, Number.NaN, 1] }],
    ["all-zero weights", { weights: [0, 0, 0] }],
    ["final period without an instalment", { weights: [1, 1, 0] }],
    ["impossible date", { startDate: "2026-02-30" }],
    ["malformed date", { startDate: "2026-1-15" }],
    ["first due date not after start", { firstDueDate: "2026-01-15" }],
    ["empty rate path", { ratePath: [] }],
    ["rate path starting after the contract", { ratePath: [{ effectiveDate: "2026-01-16", annualRate: 0.1 }] }],
    ["unsorted rate path", { ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.1 }, { effectiveDate: "2025-12-01", annualRate: 0.1 }] }],
    ["negative rate", { ratePath: [{ effectiveDate: "2026-01-01", annualRate: -0.01 }] }],
    ["VAT period out of range", { vatDeferralPeriods: { vatCents: 1_000, periodIndex: 12 } }],
    ["VAT lump not below financed less balloon", { vatDeferralPeriods: { vatCents: 112_650_000, periodIndex: 1 } }],
    ["VAT lump zero", { vatDeferralPeriods: { vatCents: 0, periodIndex: 1 } }],
  ]
  for (const [name, patch] of cases) {
    it(name, () => {
      expect(() => solveStructure({ ...ok, ...patch })).toThrow(RangeError)
    })
  }

  it("accepts the unpatched base structure", () => {
    expect(() => solveStructure(ok)).not.toThrow()
  })
})
