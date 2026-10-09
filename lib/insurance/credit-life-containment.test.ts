import { describe, expect, it } from "vitest"
import {
  creditLifeAutoBundleDecision,
  creditLifeAutoBundleElection,
  isCreditLifeAutoBundleEnabled,
} from "./credit-life-containment"

describe("credit-life auto-bundle containment", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["false", false],
    ["TRUE", false],
    ["1", false],
    ["true", true],
  ] as const)("treats CREDIT_LIFE_AUTO_BUNDLE_ENABLED=%s as %s", (value, expected) => {
    expect(isCreditLifeAutoBundleEnabled({
      CREDIT_LIFE_AUTO_BUNDLE_ENABLED: value,
    })).toBe(expected)
  })

  it("defaults to a contained, non-bundling decision", () => {
    expect(creditLifeAutoBundleDecision(500_000, {})).toEqual({
      eligible: false,
      reason: "feature_disabled",
    })
  })

  it("still enforces the existing amount threshold when explicitly enabled", () => {
    const enabled = { CREDIT_LIFE_AUTO_BUNDLE_ENABLED: "true" }

    expect(creditLifeAutoBundleDecision(100_000, enabled)).toEqual({
      eligible: false,
      reason: "below_threshold",
    })
    expect(creditLifeAutoBundleDecision(100_001, enabled)).toEqual({ eligible: true })
  })

  it("distinguishes a captured agreement election from missing or malformed evidence", () => {
    expect(creditLifeAutoBundleElection(undefined)).toEqual({ resolved: false })
    expect(creditLifeAutoBundleElection(null)).toEqual({ resolved: false })
    expect(creditLifeAutoBundleElection([])).toEqual({ resolved: false })
    expect(creditLifeAutoBundleElection({})).toEqual({ resolved: false })
    expect(creditLifeAutoBundleElection({ creditLifeAutoBundleEligible: "true" })).toEqual({ resolved: false })
    expect(creditLifeAutoBundleElection({ creditLifeAutoBundleEligible: false })).toEqual({
      resolved: true,
      eligible: false,
    })
    expect(creditLifeAutoBundleElection({ creditLifeAutoBundleEligible: true })).toEqual({
      resolved: true,
      eligible: true,
    })
  })
})
