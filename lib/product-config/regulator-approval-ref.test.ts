import { afterEach, describe, expect, it } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { parseRegulatorApprovalRef } from "./regulator-approval-ref"

afterEach(() => resetActiveJurisdiction())

describe("parseRegulatorApprovalRef", () => {
  it("leaves the stored value alone when the body does not carry it", () => {
    expect(parseRegulatorApprovalRef({})).toEqual({ data: {} })
  })

  it("takes a Kenyan lender's CBK reference, trimmed, and clears it on null or blank", () => {
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    expect(parseRegulatorApprovalRef({ regulatorApprovalRef: "  CBK/DEMO/0001 " })).toEqual({ data: { regulatorApprovalRef: "CBK/DEMO/0001" } })
    expect(parseRegulatorApprovalRef({ regulatorApprovalRef: null })).toEqual({ data: { regulatorApprovalRef: null } })
    expect(parseRegulatorApprovalRef({ regulatorApprovalRef: "   " })).toEqual({ data: { regulatorApprovalRef: null } })
  })

  it.each([
    ["markup", "<b>CBK</b>"],
    ["a number", 1234],
    ["over 64 characters", `CBK/${"9".repeat(61)}`],
    ["a leading separator", "/CBK"],
  ])("refuses %s", (_label, value) => {
    setActiveJurisdiction({ jurisdiction: "KE", currency: "KES" })
    expect(parseRegulatorApprovalRef({ regulatorApprovalRef: value })).toEqual({ issues: ["regulatorApprovalRef"] })
  })

  it("refuses a reference on a South African (NCA) lender's product, which has none; null stays harmless", () => {
    expect(parseRegulatorApprovalRef({ regulatorApprovalRef: "CBK/DEMO/0001" })).toEqual({ issues: ["regulatorApprovalRef"] })
    expect(parseRegulatorApprovalRef({ regulatorApprovalRef: null })).toEqual({ data: { regulatorApprovalRef: null } })
  })
})
