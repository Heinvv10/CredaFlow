import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import { join } from "path"
import { annualisedInterestRate, formatAnnualisedRate, termInterestPercent } from "./annualised-rate"
import { calculateLoan } from "@/lib/loan-calculator"

// This number goes on NCA documents (PASQ, credit agreement, statement), so the
// tests below check it against what the CALCULATOR actually charges rather than
// against a restatement of the same formula. If the annualisation and the
// billing ever disagree, that is the bug this file exists to catch.

describe("REDUCING_BALANCE — nominal, so the figure is cap-checkable", () => {
  it("is the monthly periodic rate x 12", () => {
    expect(annualisedInterestRate({ interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" }).percent)
      .toBeCloseTo(36.0, 6)
    expect(annualisedInterestRate({ interestRatePm: 0.0275, interestModel: "REDUCING_BALANCE" }).percent)
      .toBeCloseTo(33.0, 6)
  })

  it("is labelled nominal", () => {
    const a = annualisedInterestRate({ interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" })
    expect(a.basis).toBe("nominal")
    expect(formatAnnualisedRate({ interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" }))
      .toBe("36.0% per year (nominal)")
  })

  it("is deliberately NOT the effective rate", () => {
    // (1.03)^12 - 1 = 42.58%. Nominal understates a compounding loan; that is
    // an accepted trade for a figure comparable to the short-term products and
    // checkable against an NCA Reg 42 cap, which is expressed nominally.
    const a = annualisedInterestRate({ interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" })
    expect(a.percent).toBeLessThan(42.5)
  })
})

describe("FLAT / DAILY_ACCRUAL — nominal off the DAILY rate the calculator bills", () => {
  it.each(["FLAT", "DAILY_ACCRUAL"])("%s annualises the daily rate simply", (model) => {
    // 5%/month over 30 days = a 0.16667%/day rate; x365 = 60.83%/year.
    expect(annualisedInterestRate({ interestRatePm: 0.05, interestModel: model }).percent)
      .toBeCloseTo(60.833, 2)
  })

  it("is labelled nominal, the same basis as REDUCING_BALANCE", () => {
    const a = annualisedInterestRate({ interestRatePm: 0.05, interestModel: "FLAT" })
    expect(a.basis).toBe("nominal")
    expect(a.basisLabel).toBe("per year (nominal)")
  })

  it("uses the DAILY rate, not rate x 12 — x12 would understate a 365-day term", () => {
    // (0.05/30)*365 = 60.83%, which is what a 365-day FLAT loan actually bills.
    // 0.05*12 = 60.0% would not.
    const a = annualisedInterestRate({ interestRatePm: 0.05, interestModel: "FLAT" })
    expect(a.percent).toBeCloseTo(60.833, 2)
    expect(a.percent).not.toBeCloseTo(60.0, 2)
  })

  it("does NOT report the compounded figure that was previously printed", () => {
    // The old hardcoded (1.05)^12 - 1 = 79.59% described a facility where unpaid
    // interest rolls into the balance every month. A 30-day FLAT loan has no
    // month-2 balance, so that rate overstated a mandated disclosure by ~19pp.
    const a = annualisedInterestRate({ interestRatePm: 0.05, interestModel: "FLAT" })
    // Pin the actual figure, not `Math.pow` computed on the line above — that
    // asserted the language's exponent operator, not this module.
    expect(a.percent).toBeCloseTo(60.833, 2)
    expect(a.percent).toBeLessThan(79.5)
  })
})

describe("every product annualises on the SAME basis, so the figures compare", () => {
  it.each([
    ["FLAT", 0.05],
    ["DAILY_ACCRUAL", 0.05],
    ["REDUCING_BALANCE", 0.03],
  ])("%s is nominal", (interestModel, interestRatePm) => {
    expect(annualisedInterestRate({ interestRatePm, interestModel }).basis).toBe("nominal")
  })

  it("ranks the dearer product higher — the whole point of a comparable figure", () => {
    const micro = annualisedInterestRate({ interestRatePm: 0.05, interestModel: "FLAT" }).percent
    const personal = annualisedInterestRate({ interestRatePm: 0.03, interestModel: "REDUCING_BALANCE" }).percent
    expect(micro).toBeGreaterThan(personal)
    // And the gap is not compressed by mixing bases: 60.83 / 36.0 = 1.69x.
    expect(micro / personal).toBeGreaterThan(1.6)
  })
})

describe("the quoted annual rate matches what the calculator actually bills", () => {
  // The real guard: derive the annual rate from a full year of the product's own
  // charging behaviour and check the disclosure agrees.
  it("FLAT: a 365-day loan's interest equals the quoted simple annual rate", () => {
    const r = calculateLoan({
      principal: 100000, termDays: 365, interestRatePm: 0.05,
      interestModel: "FLAT", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0,
    productType: "MICRO",
    })
    const actualPct = (r.totalInterest / 100000) * 100
    const quoted = annualisedInterestRate({ interestRatePm: 0.05, interestModel: "FLAT" }).percent
    expect(actualPct).toBeCloseTo(quoted, 1)
  })

  it("DAILY_ACCRUAL: same — the daily rate is the basis in both", () => {
    const r = calculateLoan({
      principal: 100000, termDays: 365, interestRatePm: 0.02,
      interestModel: "DAILY_ACCRUAL", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0,
    productType: "MICRO",
    })
    const actualPct = (r.totalInterest / 100000) * 100
    const quoted = annualisedInterestRate({ interestRatePm: 0.02, interestModel: "DAILY_ACCRUAL" }).percent
    expect(actualPct).toBeCloseTo(quoted, 1)
  })

  it("FLAT 30-day: the consumer pays the MONTHLY rate, not the annual one", () => {
    // The confusion this disclosure change exists to remove.
    const r = calculateLoan({
      principal: 300000, termDays: 30, interestRatePm: 0.05,
      interestModel: "FLAT", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 0,
    productType: "MICRO",
    })
    expect(r.totalInterest).toBe(15000) // R150 on R3,000
    expect(termInterestPercent({ principal: 300000, totalInterest: r.totalInterest })).toBeCloseTo(5, 2)
  })
})

describe("termInterestPercent reflects the actual charge", () => {
  it("is derived from billed interest, so it cannot drift from the schedule", () => {
    const r = calculateLoan({
      principal: 1000000, termDays: 180, interestRatePm: 0.03,
      interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 0.165, initiationFeeMax: 108000,
      monthlyServiceFee: 6900,
    productType: "MICRO",
    })
    const scheduleInterest = r.schedule.reduce((s, x) => s + x.interestDue, 0)
    expect(scheduleInterest).toBe(r.totalInterest)
    expect(termInterestPercent({ principal: 1000000, totalInterest: r.totalInterest }))
      .toBeCloseTo((r.totalInterest / 1000000) * 100, 6)
  })

  it("guards a zero principal instead of dividing by it", () => {
    expect(termInterestPercent({ principal: 0, totalInterest: 5000 })).toBe(0)
  })
})

describe("an unknown model fails loudly rather than guessing", () => {
  it("throws instead of silently annualising on the wrong basis", () => {
    // A new InterestModel added to the schema must not reach a consumer document
    // with an unverified rate.
    expect(() => annualisedInterestRate({ interestRatePm: 0.05, interestModel: "COMPOUND_WEEKLY" }))
      .toThrow(/unsupported interestModel/)
    expect(() => annualisedInterestRate({ interestRatePm: 0.05, interestModel: "" }))
      .toThrow(/unsupported interestModel/)
  })

  it("covers every InterestModel the SCHEMA defines", () => {
    // Reads prisma/schema.prisma rather than restating the list here — a
    // hardcoded copy would agree with the switch by construction and could
    // never fail. Adding an enum value now breaks this until the annualisation
    // basis for it is decided.
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8")
    const block = schema.match(/enum InterestModel \{([^}]*)\}/)
    expect(block, "InterestModel enum not found — did the schema change shape?").toBeTruthy()
    const models = block![1].split("\n").map((l) => l.trim()).filter((l) => /^[A-Z_]+$/.test(l))
    expect(models.length).toBeGreaterThanOrEqual(3)
    for (const m of models) {
      expect(
        () => annualisedInterestRate({ interestRatePm: 0.05, interestModel: m }),
        `no annualisation basis defined for schema model ${m}`,
      ).not.toThrow()
    }
  })
})
