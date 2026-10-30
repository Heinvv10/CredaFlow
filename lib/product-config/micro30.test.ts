import { describe, expect, it } from "vitest"
import {
  MICRO30_APPROVED_CONTRACT,
  micro30ContractIssues,
  micro30DecisionTermsChanged,
} from "./micro30"

const approved = {
  code: "MICRO30",
  ...MICRO30_APPROVED_CONTRACT,
}

describe("MICRO30 approved product contract", () => {
  it("accepts only fixed 30-day, 5% monthly daily accrual with the R69 fee", () => {
    expect(micro30ContractIssues(approved)).toEqual([])
  })

  it.each([
    ["flat interest", { interestModel: "FLAT" }, "interestModel"],
    ["zero service fee", { monthlyServiceFee: 0 }, "monthlyServiceFee"],
    ["variable term", { minTermDays: 7 }, "minTermDays"],
    ["wrong monthly rate", { interestRatePm: 0.5 }, "interestRatePm"],
  ])("rejects %s", (_label, change, issue) => {
    expect(micro30ContractIssues({ ...approved, ...change })).toContain(issue)
  })

  it("detects a decision-bearing product edit", () => {
    expect(micro30DecisionTermsChanged(
      approved,
      { ...approved, monthlyServiceFee: 0 },
    )).toBe(true)
    expect(micro30DecisionTermsChanged(approved, approved)).toBe(false)
  })
})

describe("isMicro30Code", () => {
  it.each(["MICRO30", "micro30", " Micro30 ", "MICRO30\t"])("recognises %j as the MICRO30 contract product", async (code) => {
    const { isMicro30Code } = await import("./micro30")
    expect(isMicro30Code(code)).toBe(true)
  })

  it.each(["MICRO31", "MICRO 30", "XMICRO30", "", null, undefined, 30])("does not take %j for it", async (code) => {
    const { isMicro30Code } = await import("./micro30")
    expect(isMicro30Code(code)).toBe(false)
  })
})
