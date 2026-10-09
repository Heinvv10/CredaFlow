import { describe, it, expect } from "vitest"
import { describeInstalments, formatInstalmentPattern } from "./instalment-pattern"
import { calculateLoan } from "@/lib/loan-calculator"

// Driven off the real calculator's schedule, because the whole point is that
// the disclosure must match the rows that are actually billed — not the
// level-instalment scalar the documents used to quote.

const fmt = (c: number) => "R" + (c / 100).toFixed(2)

const PERSONAL_180 = {
  productType: "PERSONAL" as const,
  principal: 1000000, termDays: 180, interestRatePm: 0.03,
  interestModel: "REDUCING_BALANCE" as const,
  initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0.165, initiationFeeMax: 108000, monthlyServiceFee: 6900,
}

describe("a DEFERRED initiation fee makes instalment 1 bigger", () => {
  const calc = calculateLoan({ ...PERSONAL_180, initiationFeePayment: "DEFERRED" })
  const p = describeInstalments(calc.schedule)

  it("reports the real first instalment, not the level figure", () => {
    // The defect: documents said "Monthly Instalment R1,914.98" while the
    // consumer was actually debited R2,994.98 in month one.
    expect(calc.monthlyInstalment).toBe(191498)
    expect(p.first).toBe(299498)
    expect(p.first - calc.monthlyInstalment).toBe(calc.initiationFee)
  })

  it("is not uniform, and says so", () => {
    expect(p.uniform).toBe(false)
    expect(p.count).toBe(6)
  })

  it("names the first payment before the repeated one", () => {
    const label = formatInstalmentPattern(p, fmt)
    expect(label).toContain("First R2994.98")
    expect(label.indexOf("First")).toBeLessThan(label.indexOf("then"))
  })

  it("calls out a final instalment that differs by rounding", () => {
    expect(p.last).toBe(191496) // two cents less
    expect(formatInstalmentPattern(p, fmt)).toContain("final R1914.96")
  })

  it("every amount it names appears in the billed schedule", () => {
    const billed = calc.schedule.map((s) => s.totalDue)
    for (const amount of [p.first, p.regular, p.last]) {
      expect(billed).toContain(amount)
    }
  })
})

describe("UPFRONT deduction leaves the instalments level", () => {
  const calc = calculateLoan({ ...PERSONAL_180, initiationFeePayment: "UPFRONT" })
  const p = describeInstalments(calc.schedule)

  it("has no inflated first payment — the fee came off the advance", () => {
    expect(p.first).toBe(calc.monthlyInstalment)
  })

  it("still flags the rounding cent on the final row rather than claiming uniform", () => {
    expect(p.last).not.toBe(p.regular)
    expect(p.uniform).toBe(false)
    expect(formatInstalmentPattern(p, fmt)).toContain("final")
  })
})

describe("single-payment (bullet) loans", () => {
  const calc = calculateLoan({
    productType: "MICRO",
    principal: 300000, termDays: 30, interestRatePm: 0.05,
    interestModel: "FLAT", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.15, initiationFeeMax: 100000,
    monthlyServiceFee: 0, initiationFeePayment: "DEFERRED",
  })
  const p = describeInstalments(calc.schedule)

  it("states one amount, with no misleading 'x 1'", () => {
    expect(p.count).toBe(1)
    expect(formatInstalmentPattern(p, fmt)).toBe(fmt(calc.schedule[0].totalDue))
  })

  it("that amount is the whole total repayable", () => {
    expect(p.first).toBe(calc.totalRepayable)
  })
})

describe("truly uniform schedules read cleanly", () => {
  it("collapses to 'amount x count'", () => {
    const p = describeInstalments([{ totalDue: 50000 }, { totalDue: 50000 }, { totalDue: 50000 }])
    expect(p.uniform).toBe(true)
    expect(formatInstalmentPattern(p, fmt)).toBe("R500.00 x 3")
  })

  it("takes the RECURRING row (schedule[1]), not the most-common amount", () => {
    // The C1 defect: on a 3-row schedule the final row differs by a rounding
    // cent, so NO amount repeats. A most-common tally then returns the
    // fee-loaded FIRST instalment and the agreement prints it as the recurring
    // one. schedule[1] is the recurring amount by construction.
    const p = describeInstalments([
      { totalDue: 468430 },
      { totalDue: 360430 },
      { totalDue: 360431 },
    ])
    expect(p.regular).toBe(360430)
    expect(p.regular).not.toBe(468430)
  })

  it("handles an empty schedule without dividing or throwing", () => {
    const p = describeInstalments([])
    expect(p.count).toBe(0)
    expect(formatInstalmentPattern(p, fmt)).toBe("—")
  })
})

describe("the formatter respects the caller's money channel", () => {
  it("uses whatever formatter is injected, so nbsp/plain-space stay separate", () => {
    const p = describeInstalments([{ totalDue: 100000 }, { totalDue: 100000 }])
    expect(formatInstalmentPattern(p, (c) => `ZAR ${c}`)).toBe("ZAR 100000 x 2")
  })
})

describe("REGRESSION C1 — a 90-day personal loan must not overstate instalment 2", () => {
  // Reproduced from the real product config: PERSONAL is REDUCING_BALANCE with
  // minTermDays 90 and a DEFERRED fee by default, giving round(90/30) = 3 rows
  // where the last differs by a rounding cent. The agreement printed
  // "R4,684.30 x 2" against a real second instalment of R3,604.30 — overstated
  // by the entire R1,080 initiation fee, on a signed NCA credit agreement.
  const PRINCIPALS = [500000, 1000000, 2000000, 3500000, 5000000, 10000000]

  it.each(PRINCIPALS)("principal %i: the named recurring amount is row 2", (principal) => {
    const calc = calculateLoan({
      principal, termDays: 90, interestRatePm: 0.03,
      interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.165,
      initiationFeeMax: 108000, monthlyServiceFee: 6900,
      productType: "MICRO",
      initiationFeePayment: "DEFERRED",
    })
    const p = describeInstalments(calc.schedule)
    expect(calc.schedule).toHaveLength(3)
    expect(p.regular).toBe(calc.schedule[1].totalDue)
    expect(p.regular).not.toBe(calc.schedule[0].totalDue)
    // And the rendered line must not claim the fee-loaded amount twice.
    expect(formatInstalmentPattern(p, fmt)).not.toContain(`${fmt(calc.schedule[0].totalDue)} x 2`)
  })

  it.each(PRINCIPALS)("principal %i: named amounts agree with the billed rows", (principal) => {
    const calc = calculateLoan({
      principal, termDays: 90, interestRatePm: 0.03,
      interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.165,
      initiationFeeMax: 108000, monthlyServiceFee: 6900,
      productType: "MICRO",
      initiationFeePayment: "DEFERRED",
    })
    const label = formatInstalmentPattern(describeInstalments(calc.schedule), fmt)
    for (const row of calc.schedule) expect(label).toContain(fmt(row.totalDue))
  })
})

describe("every row is accounted for exactly once", () => {
  // Guards C8: an unguarded middle-count could silently drop or double-count a
  // row on a legally binding line.
  const shapes: number[][] = [
    [100, 100],                 // 2 uniform
    [300, 100],                 // 2, fee-loaded first
    [300, 100, 101],            // 3, distinct final (the C1 shape)
    [300, 100, 100],            // 3, repeated final
    [100, 100, 101],            // 3, level first
    [300, 100, 100, 100, 99],   // 5, both ends distinct
    [100, 100, 100, 100],       // 4 uniform
  ]

  it.each(shapes.map((s) => [JSON.stringify(s), s] as [string, number[]]))(
    "%s names every instalment",
    (_label, shape) => {
      const p = describeInstalments(shape.map((totalDue) => ({ totalDue })))
      const line = formatInstalmentPattern(p, fmt)
      // Sum the amounts the line actually names, honouring any "x N" multiplier.
      let named = 0
      for (const m of line.matchAll(/R([\d.]+)(?: x (\d+))?/g)) {
        named += m[2] ? Number(m[2]) : 1
      }
      expect(named, `"${line}" accounts for ${named} of ${shape.length} rows`).toBe(shape.length)
    },
  )

  it("never emits a bare 'x 1'", () => {
    for (const shape of shapes) {
      const line = formatInstalmentPattern(describeInstalments(shape.map((totalDue) => ({ totalDue }))), fmt)
      expect(line, line).not.toContain("x 1")
    }
  })
})
