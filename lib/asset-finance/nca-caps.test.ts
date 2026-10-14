import { describe, expect, it } from "vitest"
import {
  NCA_ASSET_CAPS,
  assetFinanceNcaCapProblems,
  maxAssetFinanceAnnualRate,
  maxAssetFinanceInitiationFeeCents,
} from "./nca-caps"

const R = (rands: number) => Math.round(rands * 100)

describe("NCA asset-finance caps", () => {
  it.each(["INSTALMENT_SALE", "FINANCE_LEASE"] as const)("uses repo + 17 points for %s", (contractType) => {
    expect(maxAssetFinanceAnnualRate(contractType, 0.0725)).toBeCloseTo(0.2425, 10)
  })

  it("uses the existing tiered initiation-fee ceiling, including VAT", () => {
    expect(maxAssetFinanceInitiationFeeCents(R(3_000))).toBe(R(419.75))
    expect(maxAssetFinanceInitiationFeeCents(R(500_000))).toBe(R(1_207.50))
  })

  it("states the current service-fee ceiling in cents", () => {
    expect(NCA_ASSET_CAPS.monthlyServiceFeeCents).toBe(R(60))
  })

  it("reports every breached cap and accepts figures exactly at the ceilings", () => {
    const atCap = {
      contractType: "FINANCE_LEASE" as const,
      repoAnnualRate: 0.0725,
      annualRate: 0.2425,
      principalCents: R(500_000),
      initiationFeeCents: R(1_207.50),
      monthlyServiceFeeCents: R(60),
    }
    expect(assetFinanceNcaCapProblems(atCap)).toEqual([])
    expect(assetFinanceNcaCapProblems({
      ...atCap,
      annualRate: 0.242501,
      initiationFeeCents: R(1_207.51),
      monthlyServiceFeeCents: R(60.01),
    }).map((problem) => problem.field)).toEqual(["annualRate", "initiationFeeCents", "monthlyServiceFeeCents"])
  })
})
