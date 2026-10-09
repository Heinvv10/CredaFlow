import { describe, expect, it } from "vitest"
import { automationOccurrenceKey } from "./occurrence"

describe("automationOccurrenceKey", () => {
  it("is stable within a cooldown window and changes for the next occurrence", () => {
    const first = new Date("2026-07-22T01:00:00.000Z")
    const sameWindow = new Date("2026-07-22T23:00:00.000Z")
    const nextWindow = new Date("2026-07-23T01:00:00.000Z")

    expect(automationOccurrenceKey("DPD_THRESHOLD", sameWindow))
      .toBe(automationOccurrenceKey("DPD_THRESHOLD", first))
    expect(automationOccurrenceKey("DPD_THRESHOLD", nextWindow))
      .not.toBe(automationOccurrenceKey("DPD_THRESHOLD", first))
  })

  it("uses the trigger-specific cooldown for long-lived events", () => {
    const first = new Date("2026-01-01T00:00:00.000Z")
    const thirtyDaysLater = new Date(first.getTime() + 30 * 86_400_000)

    expect(automationOccurrenceKey("LOAN_PAID_IN_FULL", thirtyDaysLater))
      .toBe(automationOccurrenceKey("LOAN_PAID_IN_FULL", first))
    expect(automationOccurrenceKey("LOAN_PAID_ON_TIME_N", thirtyDaysLater))
      .not.toBe(automationOccurrenceKey("LOAN_PAID_ON_TIME_N", first))
  })
})
