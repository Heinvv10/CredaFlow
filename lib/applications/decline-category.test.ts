import { describe, expect, it } from "vitest"
import {
  DECLINE_CATEGORIES,
  DECLINE_CLIENT_REASONS,
  clientDeclineReason,
  isBureauDeclineCategory,
  parseDeclineCategory,
} from "./decline-category"

describe("decline categories", () => {
  it("include Fraud, Policy and Other (Fair Score audit 2026-10-16)", () => {
    expect(DECLINE_CATEGORIES).toEqual(expect.arrayContaining(["FRAUD", "POLICY", "OTHER"]))
    expect(parseDeclineCategory("FRAUD")).toBe("FRAUD")
    expect(parseDeclineCategory("NOT_A_CATEGORY")).toBeNull()
  })

  it("never tell a client they are suspected of fraud", () => {
    expect(DECLINE_CLIENT_REASONS.FRAUD.toLowerCase()).not.toContain("fraud")
  })

  it("only the bureau-based categories name a bureau", () => {
    expect(DECLINE_CATEGORIES.filter(isBureauDeclineCategory).sort()).toEqual(["ADVERSE_LISTING", "BUREAU_SCORE", "DEBT_REVIEW"])
  })
})

describe("clientDeclineReason", () => {
  it("uses what staff wrote for the client, trimmed", () => {
    expect(clientDeclineReason("AFFORDABILITY", "  Your instalment would be too high.  ")).toBe("Your instalment would be too high.")
  })

  it("falls back to the category's client text, never the bare word Declined", () => {
    expect(clientDeclineReason("BUREAU_SCORE", "")).toBe(DECLINE_CLIENT_REASONS.BUREAU_SCORE)
    expect(clientDeclineReason("BUREAU_SCORE", null)).not.toBe("Declined")
  })

  it("has no default for Other: staff must write the client's reason", () => {
    expect(clientDeclineReason("OTHER", "  ")).toBeNull()
  })
})
