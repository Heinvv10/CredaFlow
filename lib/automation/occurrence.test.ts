import { describe, expect, it } from "vitest"
import { automationCooldownMs } from "./occurrence"

describe("automationCooldownMs", () => {
  it("is daily by default and longer for long-lived events", () => {
    expect(automationCooldownMs("DPD_THRESHOLD")).toBe(86_400_000)
    expect(automationCooldownMs("LOAN_PAID_ON_TIME_N")).toBe(30 * 86_400_000)
    expect(automationCooldownMs("UNKNOWN_TRIGGER")).toBe(86_400_000)
  })
})
