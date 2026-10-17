import { describe, expect, it } from "vitest"
import { correctionBalance, correctionCashEvents } from "./rate-correction"

const old = [{ effectiveDate: "2026-01-01", annualRate: 0.10 }]
describe("late closed-book correction", () => {
  it("uses actual cash value dates and excludes fees exactly once", () => {
    const events = correctionCashEvents([{ totalDue: 11000, interestDue: 1000, feesDue: 1000 }], [
      { amount: 2000, receivedAt: new Date("2026-01-15T10:00:00+02:00"), defaultInterestAllocated: 0, chargeFeesAllocated: 0 },
      { amount: 9000, receivedAt: new Date("2026-01-31T10:00:00+02:00"), defaultInterestAllocated: 0, chargeFeesAllocated: 0 },
    ])
    expect(events).toEqual([{ day: "2026-01-15", capitalCashCents: 1000 }, { day: "2026-01-31", capitalCashCents: 9000 }])
  })
  it("matches independent daily interest arithmetic on a paid account", () => {
    const cash = [{ day: "2026-01-31", capitalCashCents: 105000 }]
    const revised = [...old, { effectiveDate: "2026-01-15", annualRate: 0.08 }]
    const before = correctionBalance(100000, "2026-01-01", old, cash)
    const after = correctionBalance(100000, "2026-01-01", revised, cash)
    expect(before).toBe(100000 + Math.round(100000 * 0.10 * 30 / 365) - 105000)
    expect(after).toBe(100000 + Math.round(100000 * (0.10 * 13 + 0.08 * 17) / 365) - 105000)
    expect(after - before).toBe(-93)
  })
  it("does not accrue debtor interest on a credit balance", () => {
    expect(correctionBalance(100000, "2026-01-01", old, [{ day: "2026-01-31", capitalCashCents: 105000 }, { day: "2026-02-28", capitalCashCents: 0 }])).toBe(-4178)
  })
})
