import { afterEach, describe, expect, it, vi } from "vitest"
import { analyseArrangement } from "./arrangement-tracker"

/**
 * Which SAST day a receipt lands on decides whether an instalment of a payment
 * arrangement counts as KEPT or MISSED — and two missed instalments mark the
 * arrangement BROKEN, which is a collections escalation against a real person.
 *
 * The container has no TZ, so this bucketed payments by UTC day: everything
 * between 00:00 and 02:00 SAST was filed under the previous day. These pin
 * that two-hour band. `vi.setSystemTime` is used because `analyseArrangement`
 * reads the clock to decide what is UPCOMING.
 */

const WEEKLY = {
  agreedAmount: 100_000,
  frequency: "WEEKLY",
  startDate: new Date("2026-08-03T00:00:00Z"), // Monday 3 Aug
  endDate: new Date("2026-08-09T00:00:00Z"),   // one instalment window
}

afterEach(() => vi.useRealTimers())

function at(iso: string) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(iso))
}

describe("arrangement tracker — SAST day bucketing", () => {
  it("credits a payment made at 00:30 SAST on the first day of the window", () => {
    at("2026-08-20T09:00:00Z")
    // 2026-08-02T22:30Z is 00:30 SAST on 3 August — the arrangement's own
    // start date. Bucketed by UTC day it read as 2 August, fell OUTSIDE the
    // window entirely and was credited to nothing: the instalment showed
    // MISSED and the client was escalated for an arrangement they had kept.
    const summary = analyseArrangement(WEEKLY, [
      { id: "p1", amount: 100_000, receivedAt: new Date("2026-08-02T22:30:00Z") },
    ])

    expect(summary.installments[0].actualAmount).toBe(100_000)
    expect(summary.installments[0].status).toBe("PAID")
    expect(summary.missedCount).toBe(0)
    expect(summary.overallStatus).not.toBe("BROKEN")
  })

  it("does not credit a payment made before the window opens in SAST", () => {
    at("2026-08-20T09:00:00Z")
    // 21:30Z on 2 Aug is 23:30 SAST on 2 August — genuinely the day before.
    const summary = analyseArrangement(WEEKLY, [
      { id: "p1", amount: 100_000, receivedAt: new Date("2026-08-02T21:30:00Z") },
    ])

    expect(summary.installments[0].actualAmount).toBe(0)
    expect(summary.installments[0].status).toBe("MISSED")
  })

  it("pushes a payment at 00:30 SAST after the window into the next period", () => {
    at("2026-08-25T09:00:00Z")
    // 2026-08-09T22:30Z is 00:30 SAST on 10 August. The first window runs
    // 3–10 Aug exclusive, so this belongs to the SECOND instalment, not the
    // first. UTC bucketing called it 9 August and credited the wrong period.
    const twoWeeks = { ...WEEKLY, endDate: new Date("2026-08-16T00:00:00Z") }
    const summary = analyseArrangement(twoWeeks, [
      { id: "p1", amount: 100_000, receivedAt: new Date("2026-08-09T22:30:00Z") },
    ])

    expect(summary.installments[0].actualAmount).toBe(0)
    expect(summary.installments[1].actualAmount).toBe(100_000)
  })

  it("counts a payment after the final SAST day as MISSED — the direction that costs the client", () => {
    at("2026-08-20T09:00:00Z")
    // The mirror of the first case, and the one worth being explicit about.
    // 2026-08-09T22:30Z is 00:30 SAST on 10 August; the arrangement's last day
    // was the 9th. In South African terms the money arrived a day late, so the
    // instalment is MISSED and the arrangement BROKEN.
    //
    // UTC bucketing read the same receipt as 9 August and marked it PAID. So
    // this change can turn a previously-kept arrangement into a broken one,
    // and the next `arrangement-check` run writes that status, a LoanNote and
    // an audit row — a collections escalation. The new answer is the correct
    // one, but it is stricter, and the test that pins it should say so rather
    // than let the suite only cover the cases that favour the borrower.
    //
    // Blast radius measured before merge: PROD holds 0 PaymentArrangement rows,
    // so nothing is re-judged on deploy.
    const summary = analyseArrangement(WEEKLY, [
      { id: "p1", amount: 100_000, receivedAt: new Date("2026-08-09T22:30:00Z") },
    ])

    expect(summary.installments[0].status).toBe("MISSED")
    expect(summary.overallStatus).toBe("BROKEN")
  })

  it("is unchanged during the hours where UTC and SAST agree", () => {
    at("2026-08-20T09:00:00Z")
    const summary = analyseArrangement(WEEKLY, [
      { id: "p1", amount: 100_000, receivedAt: new Date("2026-08-05T09:00:00Z") },
    ])
    expect(summary.installments[0].status).toBe("PAID")
  })
})
