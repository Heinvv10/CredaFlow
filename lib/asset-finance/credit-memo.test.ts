import { describe, expect, it } from "vitest"
import { computeCreditMemo, dscr, gearing, proposedAnnualInstalmentsCents, ratio4 } from "./credit-memo"

// Every expected value below is worked by hand in the comment beside it.

const rows = (totals: number[], balloonOnLast = 0) =>
  totals.map((total, i) => ({
    totalCents: total + (i === totals.length - 1 ? balloonOnLast : 0),
    balloonCents: i === totals.length - 1 ? balloonOnLast : 0,
  }))

describe("proposedAnnualInstalmentsCents", () => {
  it.each([
    // 12 × R25 000 = R300 000 over 12 months → R300 000 a year.
    ["12 equal monthly", rows(new Array(12).fill(2_500_000)), 30_000_000],
    // 24 × R10 000 = R240 000 over 24 months → ×12/24 = R120 000; the R50 000 balloon is excluded.
    ["24 monthly + balloon", rows(new Array(24).fill(1_000_000), 5_000_000), 12_000_000],
    // Seasonal: 3 × R40 000 + 9 × R5 000 = R165 000 over 12 months.
    ["seasonal 12", rows([4_000_000, 4_000_000, 4_000_000, ...new Array(9).fill(500_000)]), 16_500_000],
    // Skip 3 then 33 × R10 000 = R330 000 over 36 months → ×12/36 = R110 000.
    ["skip 3 of 36", rows([0, 0, 0, ...new Array(33).fill(1_000_000)]), 11_000_000],
    // 3 × 10 001c + 1c = 30 004c over 7 periods → 30 004 × 12 / 7 = 360 048 / 7 = 51 435.43 → 51 435c.
    ["rounds to the cent", rows([10_001, 10_001, 10_001, 0, 0, 0, 1]), 51_435],
  ])("%s", (_label, schedule, expected) => {
    expect(proposedAnnualInstalmentsCents(schedule)).toBe(expected)
  })

  it("is 0 for an empty schedule", () => {
    expect(proposedAnnualInstalmentsCents([])).toBe(0)
  })
})

describe("ratio4 (exact, half away from zero, 4 places)", () => {
  it.each([
    [BigInt(200), BigInt(100), "2.0000"],
    [BigInt(100), BigInt(300), "0.3333"], // 0.33333…
    [BigInt(200), BigInt(300), "0.6667"], // 0.66666… rounds up
    [BigInt(-200), BigInt(300), "-0.6667"], // half away from zero on the negative side
    [BigInt(1), BigInt(32), "0.0313"], // 0.03125: exactly half → away from zero
    [BigInt(-1), BigInt(32), "-0.0313"],
    [BigInt(0), BigInt(5), "0.0000"],
    [BigInt(999_999_999), BigInt(10_000), "99999.9999"], // the DECIMAL(9,4) maximum
  ])("%s / %s = %s", (num, den, expected) => {
    expect(ratio4(num, den)).toBe(expected)
  })

  it("is null when the denominator is 0 (division by zero)", () => {
    expect(ratio4(BigInt(5), BigInt(0))).toBeNull()
  })

  it("is null beyond the column's ±99 999.9999", () => {
    expect(ratio4(BigInt(100_000), BigInt(1))).toBeNull()
    expect(ratio4(BigInt(-100_000), BigInt(1))).toBeNull()
  })
})

describe("dscr and gearing", () => {
  it("DSCR = EBITDA / (existing + proposed annual debt service)", () => {
    // R1 200 000 / (R300 000 + R300 000) = 2.0000
    expect(dscr({ ebitdaCents: 120_000_000, existingDebtServiceCents: 30_000_000, proposedAnnualCents: 30_000_000 })).toBe("2.0000")
    // R1 000 000 / (R250 000 + R500 000) = 1.33333… → 1.3333
    expect(dscr({ ebitdaCents: 100_000_000, existingDebtServiceCents: 25_000_000, proposedAnnualCents: 50_000_000 })).toBe("1.3333")
    // A loss-making year: −R150 000 / R600 000 = −0.25
    expect(dscr({ ebitdaCents: -15_000_000, existingDebtServiceCents: 0, proposedAnnualCents: 60_000_000 })).toBe("-0.2500")
  })

  it("DSCR is null with no debt service at all", () => {
    expect(dscr({ ebitdaCents: 1, existingDebtServiceCents: 0, proposedAnnualCents: 0 })).toBeNull()
  })

  it("gearing = total liabilities / total assets", () => {
    // R450 000 / R1 500 000 = 0.3
    expect(gearing({ totalLiabilitiesCents: 45_000_000, totalAssetsCents: 150_000_000 })).toBe("0.3000")
    // R2 000 000 / R1 500 000 = 1.33333…
    expect(gearing({ totalLiabilitiesCents: 200_000_000, totalAssetsCents: 150_000_000 })).toBe("1.3333")
    expect(gearing({ totalLiabilitiesCents: 1, totalAssetsCents: 0 })).toBeNull()
  })

  it("stays exact on figures beyond 2^53 when multiplied (BIGINT arithmetic)", () => {
    // R80 trillion / R30 trillion = 2.66666… → 2.6667
    expect(gearing({ totalLiabilitiesCents: 8_000_000_000_000_000, totalAssetsCents: 3_000_000_000_000_000 })).toBe("2.6667")
  })
})

describe("computeCreditMemo", () => {
  it("derives the proposed annual instalments from the schedule and both ratios", () => {
    const memo = computeCreditMemo(
      { ebitdaCents: 120_000_000, existingDebtServiceCents: 30_000_000, totalLiabilitiesCents: 45_000_000, totalAssetsCents: 150_000_000 },
      rows(new Array(12).fill(2_500_000)),
    )
    expect(memo).toEqual({ proposedAnnualInstalmentsCents: 30_000_000, dscr: "2.0000", gearing: "0.3000" })
  })
})
