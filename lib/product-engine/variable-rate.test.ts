import { describe, expect, it, vi } from "vitest"
import { affordabilityInputFingerprint, type AffordabilityDecisionInputs } from "@/lib/affordability/snapshot"
import { versionLimitRefusal, type ApprovalTerms } from "./approval-terms"
import { priceApplication } from "./resolve"
import { parseProductConfig, ncaStructureIssues } from "./terms"
import { frozenVariableRate, rateFromReference, referenceOn } from "./variable-rate"

const config = (over: Record<string, unknown> = {}) => ({
  minAmountCents: 100_000, maxAmountCents: 800_000, minTermDays: 90, maxTermDays: 360, interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0.05,
  initiationFeeMaxCents: 100_000, monthlyServiceFeeCents: 0, repayment: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0 }, variableRate: { basis: "PRIME", marginPa: 0.03 },
  collateral: [], eligibility: { minAge: null, maxAge: null, minMonthlyIncomeCents: null, minEmploymentMonths: null }, ...over,
})
const problems = (raw: unknown) => {
  try {
    parseProductConfig(raw)
    return ""
  } catch (error) {
    return (error as { problems: string[] }).problems.join(" | ")
  }
}

describe("a variable rate in the product configuration", () => {
  it("is kept, and a configuration that does not name one is a fixed rate", () => {
    expect(parseProductConfig(config()).variableRate).toEqual({ basis: "PRIME", marginPa: 0.03 })
    const { variableRate: _omitted, ...older } = config()
    expect(parseProductConfig(older).variableRate).toBeNull()
  })

  it.each([
    ["an unknown basis", { variableRate: { basis: "JIBAR", marginPa: 0.03 } }, "variableRate.basis"],
    ["a margin given as a percentage", { variableRate: { basis: "PRIME", marginPa: 3 } }, "variableRate.marginPa"],
    ["a flat rate", { interestModel: "FLAT" }, "reducing balance"],
    ["no repayment structure", { repayment: null }, "repayment structure"],
    ["a bullet", { repayment: { frequency: "MONTHLY", structure: "BULLET", graceKind: "NONE", graceInstalments: 0 } }, "bullet"],
    ["a full grace", { repayment: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "FULL", graceInstalments: 1 } }, "full grace"],
  ])("refuses %s", (_label, change, text) => {
    expect(problems(config(change))).toContain(text)
  })

  it("takes a balloon and a principal-only grace, which a repricing can regenerate", () => {
    expect(problems(config({ repayment: { frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, balloonPct: 0.2 } }))).toBe("")
    expect(problems(config({ repayment: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "PRINCIPAL_ONLY", graceInstalments: 1 } }))).toBe("")
  })

  it("is refused to an NCA lender, with or without a structure", () => {
    expect(ncaStructureIssues(parseProductConfig(config())).join(" ")).toContain("variableRate")
  })
})

describe("the rate of a reference", () => {
  it("is reference + margin over 12, at eight places, never below 0", () => {
    expect(rateFromReference(0.1175, 0.02)).toBe(0.01145833)
    expect(rateFromReference(0.05, -0.1)).toBe(0)
  })

  it("keeps the loan's own margin, so a rule's discount survives the reference moving", () => {
    const frozen = frozenVariableRate("PRIME", { rate: 0.12, effectiveDate: "2027-01-01" }, 0.0125)
    expect(frozen).toEqual({ basis: "PRIME", marginPa: 0.03, referenceRate: 0.12, referenceEffectiveDate: "2027-01-01" })
    expect(rateFromReference(0.13, frozen.marginPa)).toBeCloseTo(0.01333333, 8)
  })

  it("reads only an approved value of the basis, on or before the day", async () => {
    const findFirst = vi.fn(async () => ({ effectiveDate: new Date("2027-01-01T00:00:00Z"), rate: { toNumber: () => 0.12 } }))
    expect(await referenceOn({ referenceRate: { findFirst } } as never, "t", "PRIME", "2027-02-01")).toEqual({ rate: 0.12, effectiveDate: "2027-01-01" })
    expect(findFirst.mock.calls[0]![0 as never]).toMatchObject({ where: { tenantId: "t", basis: "PRIME", status: "APPROVED", effectiveDate: { lte: new Date("2027-02-01T00:00:00Z") } }, orderBy: { effectiveDate: "desc" } })
  })
})

describe("the evidence of a variable rate", () => {
  const inputs = { monthlyIncomeCents: 1, monthlyExpensesCents: 1, applicationDebtCents: 0, clientDebtCents: 0, declaredDebtCents: 0, bureauObligationsCents: 0, proposedInstalmentCents: 1, principalCents: 1, termDays: 30, productId: "p", interestRatePm: 0.01, interestModel: "REDUCING_BALANCE", initiationFeePct: 0, initiationFeeMaxCents: 0, monthlyServiceFeeCents: 0, initiationFeePayment: "DEFERRED", ndiBufferPct: 110 } as unknown as AffordabilityDecisionInputs
  const variableRate = { basis: "PRIME" as const, marginPa: 0.03, referenceRate: 0.09, referenceEffectiveDate: "2027-01-01" }

  it("changes the fingerprint only when present, and with every part of it", () => {
    const fixed = affordabilityInputFingerprint(inputs)
    const variable = affordabilityInputFingerprint({ ...inputs, variableRate })
    expect(variable).not.toBe(fixed)
    expect(affordabilityInputFingerprint({ ...inputs, variableRate: { ...variableRate, marginPa: 0.04 } })).not.toBe(variable)
    expect(affordabilityInputFingerprint({ ...inputs, variableRate: { ...variableRate, referenceRate: 0.1 } })).not.toBe(variable)
  })

  it("a balloon share is in the fingerprint, and leaves an existing structure's unchanged", () => {
    const repayment = { frequency: "MONTHLY", structure: "BALLOON", graceKind: "NONE", graceInstalments: 0, instalments: 12 } as const
    expect(affordabilityInputFingerprint({ ...inputs, repayment: { ...repayment, balloonPct: 0.2 } })).not.toBe(affordabilityInputFingerprint({ ...inputs, repayment: { ...repayment, balloonPct: 0.3 } }))
  })
})

describe("versionLimitRefusal", () => {
  it("refuses a variable product with no approved reference value: it cannot be priced", () => {
    const terms = { limits: null, repayment: null, versioned: null, referenceMissing: "PRIME" } as unknown as ApprovalTerms
    expect(versionLimitRefusal(terms, { principalCents: 1, termDays: 1 })).toContain("PRIME")
  })
})

describe("pricing a variable rate", () => {
  const version = {
    id: "v1", tenantId: "t", productId: "p", version: 1, effectiveFrom: new Date("2026-01-01T00:00:00Z"), minAmount: 1, maxAmount: 2, minTermDays: 1, maxTermDays: 2, interestRatePm: 0.05, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0,
    monthlyServiceFee: 0, frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, balloonPct: null, rateBasis: "PRIME", rateMarginPa: 0.03, collateral: [], eligibility: {},
  }
  const rule = { id: "r1", productId: null, name: "Staff", segment: null, channel: null, riskRankMin: null, riskRankMax: null, campaignCode: null, validFrom: new Date("2026-01-01T00:00:00Z"), validTo: null, priority: 0, rateMode: "ADD", rateValue: -0.0025, initiationFeePct: null, createdAt: new Date("2026-01-01T00:00:00Z") }
  const db = (rate: number | null, rules: unknown[] = []) => ({
    productVersion: { findFirst: vi.fn(async () => version) },
    applicationPricingInput: { findFirst: vi.fn(async () => null) },
    productPricingRule: { findMany: vi.fn(async () => rules) },
    referenceRate: { findFirst: vi.fn(async () => (rate === null ? null : { effectiveDate: new Date("2026-06-01T00:00:00Z"), rate: { toNumber: () => rate } })) },
  })
  const price = (d: ReturnType<typeof db>) => priceApplication(d as never, "t", { productId: "p", applicationId: "a", riskRank: null, termDays: 360, asOf: "2027-01-01" })

  it("prices at reference + margin, not the advertised rate", async () => {
    const priced = (await price(db(0.09)))!
    expect(priced.pricing.ratePm).toBe(0.01)
    expect(priced.variableRate).toEqual({ basis: "PRIME", marginPa: 0.03, referenceRate: 0.09, referenceEffectiveDate: "2026-06-01" })
  })

  it("freezes the margin after a rule's discount, so the discount is the loan's", async () => {
    const priced = (await price(db(0.09, [rule])))!
    expect(priced.pricing.ratePm).toBeCloseTo(0.0075, 8)
    expect(priced.variableRate!.marginPa).toBeCloseTo(0, 8)
  })

  it("names the basis it could not price on", async () => {
    expect(await price(db(null))).toMatchObject({ variableRate: null, variableBasis: "PRIME" })
  })
})
