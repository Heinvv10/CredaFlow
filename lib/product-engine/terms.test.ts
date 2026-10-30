import { describe, expect, it } from "vitest"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { instalmentsFor, monthlyEquivalentInstalment, ncaStructureIssues, parseProductConfig, repaymentTermsFor, type ProductConfig } from "./terms"
import { generateSchedule } from "./schedule"

const base = {
  minAmountCents: 100_000, maxAmountCents: 5_000_000, minTermDays: 28, maxTermDays: 360,
  interestRatePm: 0.03, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.05, initiationFeeMaxCents: 100_000, monthlyServiceFeeCents: 6_900,
  repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 },
  collateral: [{ code: "PAYSLIP", description: "Latest payslip", required: true }],
  eligibility: { minAge: 18, maxAge: 65, minMonthlyIncomeCents: 300_000, minEmploymentMonths: 6 },
}
const issues = (raw: unknown) => {
  try {
    parseProductConfig(raw)
    return []
  } catch (error) {
    return (error as InvalidPayloadError).problems
  }
}

describe("parseProductConfig", () => {
  it("accepts a complete configuration and returns it normalised", () => {
    const config = parseProductConfig(base)
    expect(config).toMatchObject({ interestRatePm: 0.03, repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 } })
    expect(config.collateral).toEqual([{ code: "PAYSLIP", description: "Latest payslip", required: true }])
  })

  it("accepts a configuration with no repayment structure: the product keeps the single-payment / monthly behaviour it has", () => {
    expect(parseProductConfig({ ...base, repayment: null, interestModel: "DAILY_ACCRUAL" }).repayment).toBeNull()
  })

  it.each([
    ["an amount range the wrong way round", { minAmountCents: 9_000_000 }, "maxAmountCents"],
    ["a term range the wrong way round", { minTermDays: 400 }, "maxTermDays"],
    ["a negative rate", { interestRatePm: -0.01 }, "interestRatePm"],
    ["a rate of 100% a month or more", { interestRatePm: 1 }, "interestRatePm"],
    ["an unknown frequency", { repayment: { ...base.repayment, frequency: "DAILY" } }, "repayment.frequency"],
    ["an unknown structure", { repayment: { ...base.repayment, structure: "BALLOON" } }, "repayment.structure"],
    ["a grace kind without periods", { repayment: { ...base.repayment, graceKind: "FULL", graceInstalments: 0 } }, "repayment.graceInstalments"],
    ["grace periods without a kind", { repayment: { ...base.repayment, graceInstalments: 2 } }, "repayment.graceInstalments"],
    ["a principal-only grace on a bullet", { repayment: { ...base.repayment, structure: "BULLET", graceKind: "PRINCIPAL_ONLY", graceInstalments: 1 } }, "repayment"],
    ["a repayment structure on a daily-accrual product", { interestModel: "DAILY_ACCRUAL" }, "repayment"],
    ["a grace that leaves nothing to pay at the shortest term", { minTermDays: 28, repayment: { ...base.repayment, graceKind: "FULL", graceInstalments: 4 } }, "repayment.graceInstalments"],
    ["an initiation fee over 100%", { initiationFeePct: 1.5 }, "initiationFeePct"],
    ["a collateral requirement with no code", { collateral: [{ code: "", description: "x", required: true }] }, "collateral"],
    ["an eligibility age range the wrong way round", { eligibility: { ...base.eligibility, minAge: 70 } }, "eligibility"],
    ["an unknown key", { surprise: 1 }, "payload"],
  ])("refuses %s", (_label, change, path) => {
    expect(issues({ ...base, ...change }).some((p) => p.startsWith(path))).toBe(true)
  })

  it("refuses an amount with a fraction of a cent", () => {
    expect(issues({ ...base, minAmountCents: 100_000.5 }).some((p) => p.startsWith("minAmountCents"))).toBe(true)
  })
})

describe("instalmentsFor and repaymentTermsFor", () => {
  it("turn a term in days into periods with the 30-day month the billing uses", () => {
    expect(instalmentsFor(84, "WEEKLY")).toBe(12)
    expect(instalmentsFor(90, "FORTNIGHTLY")).toBe(6)
    expect(instalmentsFor(180, "MONTHLY")).toBe(6)
    expect(instalmentsFor(10, "MONTHLY")).toBe(1)
  })

  it("build the engine's terms from the product's structure and the loan's term", () => {
    expect(repaymentTermsFor({ frequency: "WEEKLY", structure: "AMORTISING", graceKind: "PRINCIPAL_ONLY", graceInstalments: 2 }, 84))
      .toEqual({ frequency: "WEEKLY", structure: "AMORTISING", graceKind: "PRINCIPAL_ONLY", graceInstalments: 2, instalments: 12 })
  })
})

describe("the monthly equivalent of an instalment (what affordability compares with monthly income)", () => {
  const start = new Date("2027-02-10T12:00:00+02:00")
  type T = { frequency: "WEEKLY" | "FORTNIGHTLY" | "MONTHLY"; structure?: "AMORTISING" | "INTEREST_ONLY" | "BULLET"; graceKind?: "NONE" | "PRINCIPAL_ONLY" | "FULL"; graceInstalments?: number; instalments: number }
  const full = (t: T) => ({ structure: "AMORTISING" as const, graceKind: "NONE" as const, graceInstalments: 0, ...t })
  const run = (t: T, interestRatePm = 0.03, principalCents = 1_000_000, fee = 0) =>
    generateSchedule({ principalCents, interestRatePm, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: fee, startDate: start, terms: full(t) }).schedule

  it("weekly x 52 / 12 and fortnightly x 26 / 12 of the second row; monthly is the second row, as the existing monthly loans do", () => {
    const weekly = run({ frequency: "WEEKLY", instalments: 12 })
    expect(monthlyEquivalentInstalment(weekly, full({ frequency: "WEEKLY", instalments: 12 }))).toBe(Math.round((weekly[1]!.totalDue * 52) / 12))
    const fortnightly = run({ frequency: "FORTNIGHTLY", instalments: 6 })
    expect(monthlyEquivalentInstalment(fortnightly, full({ frequency: "FORTNIGHTLY", instalments: 6 }))).toBe(Math.round((fortnightly[1]!.totalDue * 26) / 12))
    const monthly = run({ frequency: "MONTHLY", instalments: 6 })
    expect(monthlyEquivalentInstalment(monthly, full({ frequency: "MONTHLY", instalments: 6 }))).toBe(monthly[1]!.totalDue)
  })

  it("a monthly amortising loan gives the instalment the legacy calculator gives: R43 658.55 over 84 months at 5%, R69 fee (228 877 on main)", () => {
    const rows = run({ frequency: "MONTHLY", instalments: 84 }, 0.05, 4_365_855, 6_900)
    expect(monthlyEquivalentInstalment(rows, full({ frequency: "MONTHLY", instalments: 84 }))).toBe(228_877)
  })

  it("after a principal-only grace, the first instalment that repays principal: the larger one, not the interest-only ones", () => {
    const t: T = { frequency: "MONTHLY", instalments: 6, graceKind: "PRINCIPAL_ONLY", graceInstalments: 2 }
    expect(monthlyEquivalentInstalment(run(t, 0.02), full(t))).toBe(262_624)
  })

  it("interest-only is the interest every period, not the principal that closes the last row: 4% a month on R10 000 is R400, weekly scaled by 52 / 12", () => {
    const monthly: T = { frequency: "MONTHLY", structure: "INTEREST_ONLY", instalments: 12 }
    expect(monthlyEquivalentInstalment(run(monthly, 0.04), full(monthly))).toBe(40_000)
    const weekly: T = { frequency: "WEEKLY", structure: "INTEREST_ONLY", instalments: 8 }
    const rows = run(weekly, 0.04)
    expect(monthlyEquivalentInstalment(rows, full(weekly))).toBe(Math.round((rows[1]!.totalDue * 52) / 12))
    expect(rows[1]!.totalDue).toBeLessThan(10_000)
  })

  it("an interest-only loan of two instalments is its first one, the interest, not the closing payment that carries the principal", () => {
    const t: T = { frequency: "MONTHLY", structure: "INTEREST_ONLY", instalments: 2 }
    const rows = run(t, 0.04)
    expect(rows).toHaveLength(2)
    expect(monthlyEquivalentInstalment(rows, full(t))).toBe(rows[0]!.totalDue)
    expect(rows[0]!.totalDue).toBe(40_000)
  })

  it("a bullet is its one payment, not a recurring amount: it is not scaled to a month", () => {
    const t: T = { frequency: "WEEKLY", structure: "BULLET", instalments: 8 }
    const rows = run(t, 0.04)
    expect(rows).toHaveLength(1)
    expect(monthlyEquivalentInstalment(rows, full(t))).toBe(rows[0]!.totalDue)
  })

  it("a single payment is that payment", () => {
    expect(monthlyEquivalentInstalment([{ totalDue: 1_120_000 }], full({ frequency: "MONTHLY", instalments: 1 }))).toBe(1_120_000)
  })
})

describe("what an NCA lender may configure", () => {
  const config = (over: Partial<ProductConfig> = {}): ProductConfig => ({ ...parseProductConfig({ ...base, repayment: null }), ...over })

  it("no repayment structure: the existing monthly schedule, agreement and mandate are what it describes", () => {
    expect(ncaStructureIssues(config())).toEqual([])
    expect(ncaStructureIssues(config({ interestModel: "FLAT" }))).toEqual([])
  })

  it.each([
    ["a monthly amortising structure: the engine's dates and instalment would differ from the schedule the documents describe", { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 }],
    ["a weekly frequency", { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 }],
    ["a fortnightly frequency", { frequency: "FORTNIGHTLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 }],
    ["interest-only", { frequency: "MONTHLY", structure: "INTEREST_ONLY", graceKind: "NONE", graceInstalments: 0 }],
    ["a bullet", { frequency: "MONTHLY", structure: "BULLET", graceKind: "NONE", graceInstalments: 0 }],
    ["a grace period", { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "PRINCIPAL_ONLY", graceInstalments: 1 }],
  ])("refuses %s until the lender's legal team has signed off the rendered documents", (_label, repayment) => {
    expect(ncaStructureIssues(config({ repayment } as Partial<ProductConfig>))).toEqual([expect.stringContaining("legal sign-off")])
  })

  it("refuses a monthly service fee over the R69 ceiling", () => {
    expect(ncaStructureIssues(config({ monthlyServiceFeeCents: 6_901 }))).toEqual([expect.stringContaining("Regulation 44")])
  })
})
