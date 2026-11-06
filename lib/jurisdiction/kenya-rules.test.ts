import { describe, expect, it } from "vitest"
import { JURISDICTIONS } from "./profiles"
import { KENYA_RULES, disclosesTotalCostOfCredit, exciseIncludedInFees, feeExciseRate } from "./kenya-rules"

describe("the Kenyan consumer-credit rules (draft data)", () => {
  it("charges excise on fees in Kenya only: 20%, nothing elsewhere", () => {
    expect(feeExciseRate("KE")).toBe(0.2)
    expect(feeExciseRate("ZA")).toBe(0)
    expect(feeExciseRate("LS")).toBe(0)
    for (const j of JURISDICTIONS) expect(typeof feeExciseRate(j), j).toBe("number")
  })

  it("discloses the excise already inside the fees, not on top of them: round(fees x rate / (1 + rate))", () => {
    expect(exciseIncludedInFees(146_400, 0.2)).toBe(24_400)
    expect(exciseIncludedInFees(100, 0.2)).toBe(17) // 16.67 rounds to 17 cents
    expect(exciseIncludedInFees(0, 0.2)).toBe(0)
    expect(exciseIncludedInFees(146_400, 0)).toBe(0)
  })

  it("rounds a half cent up, and stays exact at the largest fee a cents column holds", () => {
    expect(exciseIncludedInFees(3, 0.2)).toBe(1) // 0.5 cent
    expect(exciseIncludedInFees(9, 0.2)).toBe(2) // 1.5 cents
    expect(exciseIncludedInFees(2_147_483_647, 0.2)).toBe(357_913_941) // 357,913,941.17 cents
  })

  it("discloses the total cost of credit in Kenya only", () => {
    expect(disclosesTotalCostOfCredit("KE")).toBe(true)
    expect(disclosesTotalCostOfCredit("ZA")).toBe(false)
    expect(disclosesTotalCostOfCredit("LS")).toBe(false)
  })

  it("holds the rules that are data only, not wired anywhere yet", () => {
    expect(KENYA_RULES).toMatchObject({
      crbListingMinCents: 100_000, crbNoticeDays: 30, termChangeNoticeDays: 30, complaintResolutionDays: 30,
      nplInterestCap: "PRINCIPAL_AT_NPL", allocationOrder: ["PRINCIPAL", "FEES", "INTEREST"], guarantorContactNoticeDays: 14,
    })
  })
})
