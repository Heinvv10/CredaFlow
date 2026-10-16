import { describe, expect, it } from "vitest"
import { addDays, prevBusinessDay } from "./dates"
import { arrangementDays, buildPlans, type Window } from "./plan"

/** A bake window ending on `until`, the same length as the default bake (2026-04-01 … 2026-10-16). */
const windowEnding = (until: string): Window => ({ start: addDays(until, -198), until, lastBusinessDay: prevBusinessDay(addDays(until, -1)) })

const endDates = Array.from({ length: 731 }, (_, i) => addDays("2026-01-01", i))

describe("payment-arrangement storylines", () => {
  // An arrangement whose last period falls on or before the end date is paid
  // in full inside the window: the loan ends COMPLETED, not in arrangement.
  it("every arrangement's last period falls after the bake end, for any end date", () => {
    const bad: string[] = []
    for (const until of endDates) {
      for (const plan of buildPlans(windowEnding(until))) {
        const days = arrangementDays(plan)
        if (days && days[days.length - 1] <= until) bad.push(`${until} ${plan.persona.id} ends ${days[days.length - 1]}`)
      }
    }
    expect(bad).toEqual([])
  })

  it("payments have resumed by the end date (at least two arrangement payments inside the window)", () => {
    for (const until of endDates) {
      for (const plan of buildPlans(windowEnding(until))) {
        const days = arrangementDays(plan)
        if (days) expect(days.filter((d) => d <= until).length, `${until} ${plan.persona.id}`).toBeGreaterThanOrEqual(2)
      }
    }
  })

  it("arrangementDays matches the arrangement the 2026-10-16 bake booked for bg-27 (2026-07-16 … 2026-10-16)", () => {
    const plan = buildPlans(windowEnding("2026-10-16")).find((p) => p.persona.id === "bg-27")!
    const asBaked = { ...plan, originationStart: "2026-04-07", servicing: { channel: "DEBIT_ORDER" as const, paidRows: 1, arrangement: { atDpd: 36, periods: 4 } } }
    expect(arrangementDays(asBaked)).toEqual(["2026-07-16", "2026-08-17", "2026-09-16", "2026-10-16"])
  })
})
