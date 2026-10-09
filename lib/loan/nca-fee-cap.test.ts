import { describe, it, expect } from "vitest"
import { ncaInitiationFeeCap, capInitiationFee, NCA_INITIATION_FEE_CAP } from "./nca-fee-cap"
import { calculateLoan } from "@/lib/loan-calculator"

// The initiation fee is a prescribed maximum, not a pricing preference, so
// these assert the tiered shape of the statute rather than restating whatever
// the implementation happens to compute.

const R = (rands: number) => Math.round(rands * 100)

describe("the cap is TIERED, not a flat percentage", () => {
  it("adds 10% of the amount ABOVE the threshold, not 10% of the whole", () => {
    // R3,000 -> 165 + 10% x 2,000 = R365 excl -> R419.75 incl.
    // A flat-10%-of-principal reading would give R300 excl / R345 incl.
    expect(ncaInitiationFeeCap(R(3000))).toBe(R(419.75))
    expect(ncaInitiationFeeCap(R(5000))).toBe(R(649.75))
  })

  it("stops at the absolute ceiling however large the loan", () => {
    // R1,050 excl -> R1,207.50 incl, reached at R9,850 principal.
    expect(ncaInitiationFeeCap(R(10_000))).toBe(R(1207.5))
    expect(ncaInitiationFeeCap(R(100_000))).toBe(R(1207.5))
    expect(ncaInitiationFeeCap(R(500_000))).toBe(R(1207.5))
  })

  it("is monotonic — a bigger loan never permits a smaller fee", () => {
    let prev = -1
    for (let p = 0; p <= R(20_000); p += R(250)) {
      const cap = ncaInitiationFeeCap(p)
      expect(cap).toBeGreaterThanOrEqual(prev)
      prev = cap
    }
  })

  it("returns nothing for a zero or negative principal", () => {
    expect(ncaInitiationFeeCap(0)).toBe(0)
    expect(ncaInitiationFeeCap(-100)).toBe(0)
  })
})

describe("the fee may never exceed 15% of the principal debt (Reg 42 second ceiling)", () => {
  // Every figure below is worked by hand from the principal, NOT read back from
  // the module — an assertion derived from the code under test cannot fail.

  it("binds BELOW the tier, where the tier alone over-charges", () => {
    // R500 -> 15% = R75.00. The tier alone would permit R165 excl / R189.75 incl,
    // which is 37.95% of a R500 loan.
    expect(ncaInitiationFeeCap(R(500))).toBe(R(75))
    // R1,000 -> 15% = R150.00, against a tier of R189.75.
    expect(ncaInitiationFeeCap(R(1000))).toBe(R(150))
  })

  it("is the live R4.75 over-charge on a R2,000 loan", () => {
    // The tier permits R265 excl -> R304.75 incl. 15% of R2,000 is R300.00.
    // Every R2,000 loan booked before this ceiling existed took R4.75 too much.
    expect(ncaInitiationFeeCap(R(2000))).toBe(R(300))
    expect(R(304.75) - ncaInitiationFeeCap(R(2000))).toBe(R(4.75))
  })

  it("hands over to the tier at the crossover, around R2,136", () => {
    // R2,135: 15% = R320.25; tier = 165 + 10% x 1,135 = R278.50 excl -> R320.28
    // incl. The share of principal is still the lower of the two.
    expect(ncaInitiationFeeCap(R(2135))).toBe(R(320.25))
    // R2,140: 15% = R321.00; tier = 165 + 10% x 1,140 = R279.00 excl -> R320.85
    // incl. Now the TIER is lower and takes over.
    expect(ncaInitiationFeeCap(R(2140))).toBe(R(320.85))
  })

  it("does NOT bind on larger loans — neither ceiling subsumes the other", () => {
    // R3,000 -> 15% would allow R450, but the tier holds it to R419.75.
    expect(ncaInitiationFeeCap(R(3000))).toBe(R(419.75))
    // R10,000 -> 15% would allow R1,500; the absolute ceiling holds R1,207.50.
    expect(ncaInitiationFeeCap(R(10_000))).toBe(R(1207.5))
  })

  it("never permits more than 15% of principal, at any principal", () => {
    for (let p = R(100); p <= R(50_000); p += R(100)) {
      // Independent restatement of the rule, not a call back into the module.
      expect(ncaInitiationFeeCap(p)).toBeLessThanOrEqual(Math.round(p * 0.15))
    }
  })
})

describe("capInitiationFee takes the LESSER of commercial and statutory", () => {
  it("leaves a compliant configured fee untouched", () => {
    // R2,000 at 15% = R300, under the R304.75 ceiling.
    expect(capInitiationFee(R(300), R(2000))).toBe(R(300))
  })

  it("clamps a configured fee that exceeds the ceiling", () => {
    // The live defect: R3,000 at a flat 15% = R450 against a R419.75 ceiling.
    expect(capInitiationFee(R(450), R(3000))).toBe(R(419.75))
  })

  it("never RAISES a fee to the ceiling", () => {
    // A product may charge less than the maximum.
    expect(capInitiationFee(R(50), R(10_000))).toBe(R(50))
    expect(capInitiationFee(0, R(10_000))).toBe(0)
  })
})

describe("the calculator cannot charge above the statutory maximum", () => {
  // The real guard: drive the product config that was over-charging in prod.
  const MICRO = {
    interestRatePm: 0.05, interestModel: "FLAT" as const,
    initiationFeeModel: "FLAT_PCT" as const,
    initiationFeePct: 0.15, initiationFeeMax: 100_000, monthlyServiceFee: 0,
    productType: "MICRO" as const,
  }

  it("the R3,000 Micro Loan now charges the ceiling, not a flat 15%", () => {
    const calc = calculateLoan({ principal: R(3000), termDays: 30, ...MICRO })
    expect(calc.initiationFee).toBe(R(419.75))
    expect(calc.initiationFee).toBeLessThan(R(450)) // what it charged before
  })

  it.each([
    R(500), R(1000), R(1500), R(2000), R(3000), R(5000), R(8000), R(10_000), R(20_000),
  ])("principal %i never exceeds the cap", (principal) => {
    const calc = calculateLoan({ principal, termDays: 30, ...MICRO })
    expect(calc.initiationFee).toBeLessThanOrEqual(ncaInitiationFeeCap(principal))
  })

  it("holds for a product deliberately misconfigured far above the cap", () => {
    // The point of a statutory ceiling is that operator error cannot breach it.
    const calc = calculateLoan({
      principal: R(4000), termDays: 30, interestRatePm: 0.05, interestModel: "FLAT",
      initiationFeeModel: "FLAT_PCT" as const,
      initiationFeePct: 0.9, initiationFeeMax: 0, monthlyServiceFee: 0,
      productType: "MICRO",
    })
    expect(calc.initiationFee).toBe(ncaInitiationFeeCap(R(4000)))
    expect(calc.initiationFee).toBe(R(534.75))
  })

  it("the capped fee still foots into the schedule", () => {
    // Capping must not desynchronise totalRepayable from the billed rows.
    const calc = calculateLoan({
      principal: R(3000), termDays: 30, ...MICRO, initiationFeePayment: "DEFERRED",
    })
    const billed = calc.schedule.reduce((s, r) => s + r.totalDue, 0)
    expect(billed).toBe(calc.totalRepayable)
    expect(calc.totalRepayable).toBe(R(3000) + calc.totalInterest + calc.initiationFee + calc.serviceFees)
  })

  it("UPFRONT advances principal less the CAPPED fee, not the configured one", () => {
    const calc = calculateLoan({
      principal: R(3000), termDays: 30, ...MICRO, initiationFeePayment: "UPFRONT",
    })
    expect(calc.disbursementAmount).toBe(R(3000) - R(419.75))
  })
})

describe("NCA_REG42 pricing makes the CONFIG agree with the CHARGE (C7)", () => {
  // The defect: the fee table published `initiationFeePct` while the engine
  // charged the statutory figure. A product priced ON the schedule cannot
  // disagree with itself, because there is no second number to disagree with.
  const base = {
    termDays: 30, interestRatePm: 0.05, interestModel: "FLAT" as const,
    monthlyServiceFee: 0, productType: "MICRO" as const,
  }

  it("ignores initiationFeePct entirely — the schedule IS the price", () => {
    // A wildly wrong percentage must not move the fee by one cent.
    const greedy = calculateLoan({
      ...base, principal: R(3000), initiationFeeModel: "NCA_REG42",
      initiationFeePct: 0.99, initiationFeeMax: 0,
    })
    const zero = calculateLoan({
      ...base, principal: R(3000), initiationFeeModel: "NCA_REG42",
      initiationFeePct: 0, initiationFeeMax: 0,
    })
    expect(greedy.initiationFee).toBe(R(419.75))
    expect(zero.initiationFee).toBe(R(419.75))
  })

  it("still honours the product's own COMMERCIAL cap below the statute", () => {
    // Micro Loan charges at most R1,000 where Reg 42 would allow R1,207.50.
    // Pricing on the schedule must not quietly RAISE the fee to the maximum.
    const capped = calculateLoan({
      ...base, principal: R(10_000), initiationFeeModel: "NCA_REG42",
      initiationFeePct: 0.15, initiationFeeMax: R(1000),
    })
    expect(capped.initiationFee).toBe(R(1000))
    const uncapped = calculateLoan({
      ...base, principal: R(10_000), initiationFeeModel: "NCA_REG42",
      initiationFeePct: 0.15, initiationFeeMax: 0,
    })
    expect(uncapped.initiationFee).toBe(R(1207.5))
  })

  it("prices UP to the schedule when the percentage would undercharge", () => {
    // The discriminating case. A 2% configured rate is far BELOW the schedule,
    // so the two models cannot agree by coincidence here: FLAT_PCT bills R100 on
    // R5,000, the Reg 42 schedule bills R649.75. If the model is ever dropped,
    // this is the assertion that notices.
    const scheduled = calculateLoan({
      ...base, principal: R(5000), initiationFeeModel: "NCA_REG42",
      initiationFeePct: 0.02, initiationFeeMax: 0,
    })
    expect(scheduled.initiationFee).toBe(R(649.75))
    const flat = calculateLoan({
      ...base, principal: R(5000), initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0.02, initiationFeeMax: 0,
    })
    expect(flat.initiationFee).toBe(R(100))
  })

  it("prices on the schedule at every amount, not just where the cap bit", () => {
    // Independent literals, worked by hand from the statute:
    //   R500  -> 15% of principal = R75.00 (the share ceiling binds)
    //   R1,000-> 15% = R150.00
    //   R2,000-> 15% = R300.00 (tier would allow R304.75)
    //   R3,000-> 165 + 10% x 2,000 = R365 excl -> R419.75 incl
    //   R5,000-> 165 + 10% x 4,000 = R565 excl -> R649.75 incl
    const expected: [number, number][] = [
      [R(500), R(75)], [R(1000), R(150)], [R(2000), R(300)],
      [R(3000), R(419.75)], [R(5000), R(649.75)],
    ]
    for (const [principal, fee] of expected) {
      const calc = calculateLoan({
        ...base, principal, initiationFeeModel: "NCA_REG42",
        initiationFeePct: 0, initiationFeeMax: 0,
      })
      expect(calc.initiationFee).toBe(fee)
    }
  })

  it("moves no live price on the Micro Loan band", () => {
    // The switch must not reprice a live product. Both models are asserted
    // against the SAME hand-worked literals rather than against each other —
    // comparing the two calls would agree by construction under a shared bug in
    // the primitives they both use, and could not fail.
    //   R2,000  -> 15% of principal = R300.00
    //   R2,500  -> 165 + 10% x 1,500 = R315 excl -> R362.25 incl (below 15% = R375)
    //   R3,000  -> 165 + 10% x 2,000 = R365 excl -> R419.75 incl
    //   R5,000  -> 165 + 10% x 4,000 = R565 excl -> R649.75 incl
    //   R8,000  -> 165 + 10% x 7,000 = R865 excl -> R994.75 incl
    //   R10,000 -> statute allows R1,207.50; the R1,000 COMMERCIAL cap binds
    const expected: [number, number][] = [
      [R(2000), R(300)], [R(2500), R(362.25)], [R(3000), R(419.75)],
      [R(5000), R(649.75)], [R(8000), R(994.75)], [R(10_000), R(1000)],
    ]
    for (const [principal, fee] of expected) {
      for (const model of ["FLAT_PCT", "NCA_REG42"] as const) {
        const calc = calculateLoan({
          ...base, principal, initiationFeeModel: model,
          initiationFeePct: 0.15, initiationFeeMax: R(1000),
        })
        expect(calc.initiationFee).toBe(fee)
      }
    }
  })

  it("FLAT_PCT is unchanged — the old model still prices on the percentage", () => {
    // R2,000 at 10% = R200, well under the R300 ceiling, so nothing clamps it.
    const calc = calculateLoan({
      ...base, principal: R(2000), initiationFeeModel: "FLAT_PCT",
      initiationFeePct: 0.1, initiationFeeMax: 0,
    })
    expect(calc.initiationFee).toBe(R(200))
  })
})

describe("the gazetted constants are stated, not buried", () => {
  it("exposes each tier so legal can verify one place", () => {
    // If these change by regulation, this test tells you what the code believes.
    expect(NCA_INITIATION_FEE_CAP.baseFeeExclVat).toBe(R(165))
    expect(NCA_INITIATION_FEE_CAP.baseThreshold).toBe(R(1000))
    expect(NCA_INITIATION_FEE_CAP.marginalRate).toBe(0.1)
    expect(NCA_INITIATION_FEE_CAP.ceilingExclVat).toBe(R(1050))
    expect(NCA_INITIATION_FEE_CAP.vatRate).toBe(0.15)
    expect(NCA_INITIATION_FEE_CAP.principalPctCeiling).toBe(0.15)
  })
})

describe("REGRESSION: the exemption must reach every origination path", () => {
  // Blind review found productType reached exactly ONE of a dozen callers, so
  // the marketing quote said R10,000 while the SIGNED AGREEMENT and the BOOKED
  // LOAN both said R1,207.50 — an R8,792.50 under-charge per PO facility.
  // `productType` is now a REQUIRED field of LoanCalcInput precisely so a
  // missing category is a compile error rather than a silent mispricing.
  const PO = {
    interestRatePm: 0.025, interestModel: "DAILY_ACCRUAL" as const,
    initiationFeeModel: "FLAT_PCT" as const,
    initiationFeePct: 0.02, initiationFeeMax: 0, monthlyServiceFee: 0,
  }

  it("PO funding keeps its commercial fee — the consumer ceiling is not its regime", () => {
    const calc = calculateLoan({ principal: R(500_000), termDays: 120, ...PO, productType: "PO_FUNDING" })
    expect(calc.initiationFee).toBe(R(10_000))
    expect(calc.initiationFee).not.toBe(ncaInitiationFeeCap(R(500_000))) // NOT R1,207.50
  })

  it("the same facility WOULD be clamped without its category — the bug's shape", () => {
    const clamped = calculateLoan({ principal: R(500_000), termDays: 120, ...PO, productType: null })
    expect(clamped.initiationFee).toBe(R(1207.5))
    expect(R(10_000) - clamped.initiationFee).toBe(R(8792.5))
  })

  it("fails CLOSED on an unrecognised category, not open", () => {
    // Deny-by-default: adding a ProductType the module has never seen must not
    // silently disable a statutory maximum for consumers.
    const unknown = calculateLoan({
      principal: R(3000), termDays: 30, interestRatePm: 0.05, interestModel: "FLAT",
      initiationFeeModel: "FLAT_PCT" as const,
      initiationFeePct: 0.15, initiationFeeMax: 100_000, monthlyServiceFee: 0,
      productType: "SOME_FUTURE_TYPE",
    })
    expect(unknown.initiationFee).toBe(R(419.75)) // capped, NOT the configured R450
  })
})
