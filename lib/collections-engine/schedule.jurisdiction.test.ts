import { afterEach, describe, expect, it } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { debitDateOnOrAfter, earliestActionDate } from "./schedule"

afterEach(() => resetActiveJurisdiction())

describe("debit dates follow the lender's public holidays", () => {
  // 16 Jun 2026 is a Tuesday: Youth Day in South Africa, an ordinary day in Lesotho.
  it("ZA rolls a debit day on Youth Day to the next business day", () => {
    expect(debitDateOnOrAfter("2026-06-10", 16)).toBe("2026-06-17")
  })

  it("LS debits on 16 June", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(debitDateOnOrAfter("2026-06-10", 16)).toBe("2026-06-16")
  })

  // 11 Mar 2026 is a Wednesday: Moshoeshoe's Day in Lesotho only.
  it("LS rolls a debit day on Moshoeshoe's Day; ZA does not", () => {
    expect(debitDateOnOrAfter("2026-03-01", 11)).toBe("2026-03-11")
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(debitDateOnOrAfter("2026-03-01", 11)).toBe("2026-03-12")
  })

  it("the submission lead skips Lesotho holidays", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    // Lead is a fixed number of business days; from Tue 10 Mar the 11th is closed.
    const za = (resetActiveJurisdiction(), earliestActionDate("2026-03-10"))
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const ls = earliestActionDate("2026-03-10")
    expect(ls > za).toBe(true)
  })
})
