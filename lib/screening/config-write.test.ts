import { describe, expect, it } from "vitest"
import { parseScreeningConfig } from "./config-write"

const valid = { provider: "simulated", reviewMinRole: "ADMIN", requireSecondReviewer: true }

describe("parseScreeningConfig", () => {
  it("accepts a complete setting, including maker-checker on or off", () => {
    expect(parseScreeningConfig(valid)).toEqual({ ok: true, value: valid })
    expect(parseScreeningConfig({ ...valid, requireSecondReviewer: false })).toMatchObject({ ok: true, value: { requireSecondReviewer: false } })
    expect(parseScreeningConfig({ ...valid, provider: null })).toMatchObject({ ok: true, value: { provider: null } })
  })

  it("refuses a missing or non-boolean requireSecondReviewer, an unknown provider and a role outside the policy", () => {
    for (const bad of [{ ...valid, requireSecondReviewer: undefined }, { ...valid, requireSecondReviewer: "false" }, { ...valid, provider: "nope" }, { ...valid, reviewMinRole: "LOAN_ADMIN" }]) {
      expect(parseScreeningConfig(bad).ok, JSON.stringify(bad)).toBe(false)
    }
  })
})
