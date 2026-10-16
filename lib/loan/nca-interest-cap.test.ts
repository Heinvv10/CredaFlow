import { describe, expect, it } from "vitest"
import { PRODUCT_PRICING } from "@/lib/product-pricing"
import { REPO } from "@/prisma/seed/asset-finance-data"
import { checkNcaInterestRate, checkRepeatShortTermRate, ncaCreditType, productCreditType } from "./nca-interest-cap"

describe("NCA credit type (s1 short-term credit transaction)", () => {
  it("is short-term at R8,000 and 180 days, and unsecured one cent or one day beyond", () => {
    expect(ncaCreditType(800_000, 180)).toBe("SHORT_TERM")
    expect(ncaCreditType(800_001, 180)).toBe("UNSECURED")
    expect(ncaCreditType(800_000, 181)).toBe("UNSECURED")
  })

  it("prices a product by the strictest loan it can write", () => {
    // The seed MICRO30 product: R500–R2,000 for 30 days.
    expect(productCreditType({ maxAmount: 200_000, maxTermDays: 30 })).toBe("SHORT_TERM")
    // A micro product that can lend R10,000 writes unsecured credit too.
    expect(productCreditType({ maxAmount: 1_000_000, maxTermDays: 30 })).toBe("UNSECURED")
  })
})

describe("short-term cap: 5% per month", () => {
  const short = (interestRatePm: number) =>
    checkNcaInterestRate({ creditType: "SHORT_TERM", interestRatePm, interestModel: "DAILY_ACCRUAL", repoAnnualRate: null })

  it("allows exactly 5% per month without a repo rate", () => {
    expect(short(0.05)).toEqual({ ok: true })
  })

  it("refuses 5.01% per month", () => {
    expect(short(0.0501)).toMatchObject({ ok: false, reason: "ABOVE_CAP" })
  })
})

describe("unsecured cap: repo + 21% per year", () => {
  const unsecured = (interestRatePm: number, repoAnnualRate: number | null = 0.07, interestModel = "REDUCING_BALANCE") =>
    checkNcaInterestRate({ creditType: "UNSECURED", interestRatePm, interestModel, repoAnnualRate })

  it("allows the cap itself: 28% a year at a 7% repo is 2.3333% a month", () => {
    expect(unsecured(0.28 / 12)).toEqual({ ok: true })
  })

  it("refuses a hair above the cap", () => {
    expect(unsecured(0.28 / 12 + 0.00001)).toMatchObject({ ok: false, reason: "ABOVE_CAP" })
  })

  it("refuses the demo Personal Loan's 3% a month (36% a year) at a 7% repo", () => {
    const result = unsecured(0.03)
    expect(result).toMatchObject({ ok: false, reason: "ABOVE_CAP" })
    expect(!result.ok && result.message).toContain("36.00% per year (nominal) exceeds the NCA maximum of 28.00%")
  })

  it("annualises a daily-accrual rate as the PASQ does ((i/30) x 365), not i x 12", () => {
    // 2.3% a month bills 27.98% a year on a daily product and 27.6% on a reducing one.
    expect(unsecured(0.023, 0.07, "REDUCING_BALANCE")).toEqual({ ok: true })
    expect(unsecured(0.0231, 0.07, "DAILY_ACCRUAL")).toMatchObject({ ok: false, reason: "ABOVE_CAP" })
  })

  it("moves with the repo rate", () => {
    expect(unsecured(0.025, 0.0825)).toMatchObject({ ok: false }) // 30% > 29.25%
    expect(unsecured(0.025, 0.09)).toEqual({ ok: true }) // 30% <= 30%
  })

  it("refuses rather than guesses when no repo rate is recorded", () => {
    expect(unsecured(0.01, null)).toMatchObject({ ok: false, reason: "NO_REPO_RATE" })
  })
})

describe("the demo products (prisma/seed.ts, mirrored by lib/product-pricing.ts)", () => {
  // Seeded REPO (prisma/seed/asset-finance-data.ts) is 8.25%; 7% is the stricter check.
  it.each([0.0825, 0.07])("are within the cap at a %s repo", (repoAnnualRate) => {
    expect(REPO.rate).toBe("0.0825")
    const micro = PRODUCT_PRICING["short-term"]
    expect(checkNcaInterestRate({ creditType: "SHORT_TERM", ...micro, repoAnnualRate })).toEqual({ ok: true })
    for (const key of ["personal", "purchase-order", "invoice-discounting"] as const) {
      expect(checkNcaInterestRate({ creditType: "UNSECURED", ...PRODUCT_PRICING[key], repoAnnualRate })).toEqual({ ok: true })
    }
  })
})

describe("repeat short-term cap: 3% a month after the first loan in a calendar year", () => {
  it("allows 5% on the first, exactly 3% on a later one, and refuses 3.01%", () => {
    expect(checkRepeatShortTermRate(0.05, 0)).toEqual({ ok: true })
    expect(checkRepeatShortTermRate(0.03, 1)).toEqual({ ok: true })
    expect(checkRepeatShortTermRate(0.0301, 2)).toMatchObject({ ok: false, reason: "REPEAT_SHORT_TERM" })
  })
})
