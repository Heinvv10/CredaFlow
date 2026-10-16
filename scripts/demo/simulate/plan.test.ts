import { describe, expect, it } from "vitest"
import { addDays, prevBusinessDay } from "./dates"
import { BAD_SHARE_LIMIT, PAR30_LIMIT } from "./book-health"
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

describe("the scripted book a prospect sees", () => {
  const plans = buildPlans(windowEnding("2026-10-16"))
  const loans = plans.filter((p) => p.servicing)
  const storyline = (s: string) => loans.filter((p) => p.persona.storyline === s)
  const OPEN = ["active", "arrears-30", "arrears-60", "arrears-90", "s129", "payment-plan"]
  // 30+ DPD on the end date, the product's PAR30 (lib/loan/collectible-book.ts
  // collectibleParWhere: daysInArrears >= 30). arrears-30 lands on 25-35 DPD
  // (bg-19 on 30), so it counts. Of the payment plans, bg-27's DPD is not
  // pinned, so it counts; bg-28 resumed payments and sat at 25 DPD in the
  // 2026-10-16 bake. The bake's own check (book-health.ts) is the real gate.
  const atRisk = (p: (typeof loans)[number]) =>
    ["arrears-30", "arrears-60", "arrears-90", "s129"].includes(p.persona.storyline) || p.persona.id === "bg-27"
  const open = loans.filter((p) => OPEN.includes(p.persona.storyline))
  const cents = (ps: typeof loans) => ps.reduce((sum, p) => sum + p.persona.loanRequest.amountCents, 0)

  it("keeps PAR30 by amount lent well under the bake's limit", () => {
    // Headroom: the seed book (book-health.ts counts it) only adds current balances.
    expect(cents(open.filter(atRisk)) / cents(open)).toBeLessThanOrEqual(PAR30_LIMIT - 0.03)
  })

  it("keeps defaults and write-offs within the bake's limit", () => {
    // arrears-60 may already be DEFAULTED (escalation marks loans at 60 DPD).
    const bad = ["arrears-60", "arrears-90", "s129", "written-off"].flatMap(storyline)
    expect(bad.length / loans.length).toBeLessThanOrEqual(BAD_SHARE_LIMIT)
    expect(storyline("active").length).toBeGreaterThan(loans.length / 2 - storyline("settled").length)
  })
})
