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
  const run = (terms: { frequency: "WEEKLY" | "FORTNIGHTLY" | "MONTHLY"; graceKind?: "NONE" | "PRINCIPAL_ONLY" | "FULL"; graceInstalments?: number; instalments: number }, interestRatePm = 0.03) =>
    generateSchedule({ principalCents: 1_000_000, interestRatePm, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 0, startDate: start, terms: { structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, ...terms } }).schedule

  it("weekly x 52 / 12, fortnightly x 26 / 12, monthly as it is", () => {
    const weekly = run({ frequency: "WEEKLY", instalments: 12 })
    expect(monthlyEquivalentInstalment(weekly, "WEEKLY")).toBe(Math.round((Math.max(...weekly.slice(1).map((r) => r.totalDue)) * 52) / 12))
    const monthly = run({ frequency: "MONTHLY", instalments: 6 })
    expect(monthlyEquivalentInstalment(monthly, "MONTHLY")).toBe(Math.max(...monthly.slice(1).map((r) => r.totalDue)))
  })

  it("after a grace, the instalment that repays principal: the larger one, not the interest-only ones", () => {
    const rows = run({ frequency: "MONTHLY", instalments: 6, graceKind: "PRINCIPAL_ONLY", graceInstalments: 2 }, 0.02)
    expect(monthlyEquivalentInstalment(rows, "MONTHLY")).toBe(262_624)
  })

  it("a single payment is that payment", () => {
    expect(monthlyEquivalentInstalment([{ totalDue: 1_120_000 } as never], "MONTHLY")).toBe(1_120_000)
  })
})

describe("what an NCA lender may configure", () => {
  const config = (over: Partial<ProductConfig> = {}): ProductConfig => ({ ...parseProductConfig({ ...base, repayment: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 } }), ...over })

  it("a monthly amortising reducing-balance structure, or none, is what the existing documents and schedules describe", () => {
    expect(ncaStructureIssues(config())).toEqual([])
    expect(ncaStructureIssues(config({ repayment: null }))).toEqual([])
  })

  it.each([
    ["a weekly frequency", { repayment: { frequency: "WEEKLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 } }],
    ["a fortnightly frequency", { repayment: { frequency: "FORTNIGHTLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 } }],
    ["interest-only", { repayment: { frequency: "MONTHLY", structure: "INTEREST_ONLY", graceKind: "NONE", graceInstalments: 0 } }],
    ["a bullet", { repayment: { frequency: "MONTHLY", structure: "BULLET", graceKind: "NONE", graceInstalments: 0 } }],
    ["a grace period", { repayment: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "PRINCIPAL_ONLY", graceInstalments: 1 } }],
    ["a flat-rate instalment loan", { interestModel: "FLAT" as const }],
    ["a monthly service fee over the R69 ceiling", { monthlyServiceFeeCents: 6_901 }],
  ])("refuses %s until the lender's legal team has signed off the rendered documents", (_label, over) => {
    expect(ncaStructureIssues(config(over as Partial<ProductConfig>)).length).toBeGreaterThan(0)
  })
})
