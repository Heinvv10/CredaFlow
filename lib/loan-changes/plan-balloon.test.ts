import { describe, expect, it } from "vitest"
import { planReprice, type StoredRow } from "@/lib/product-engine/reprice"
import { planInPlace, type PlanInput } from "./plan"
import { at, input, loanRows, monthly, reconciles, START } from "./plan.test-helpers"

const principal = 1_200_000
const balloon = 360_000
const shape = { principal, fee: 0, terms: monthly(12, { structure: "BALLOON", balloonPct: 0.3 }) }
const given = (paid: number, change: PlanInput["change"], asOf = at("2026-04-20")): PlanInput => {
  const base = input(loanRows(shape, paid), change, { shape, structure: "BALLOON", asOf })
  return { ...base, loan: { ...base.loan, principal, balloonCents: balloon } }
}
const stored = (rows: ReturnType<typeof planInPlace>["rows"]): StoredRow[] => rows.map((r, i) => ({
  id: `n${i}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, creditLifePremiumDue: 0, totalDue: r.totalDue, totalPaid: r.totalPaid,
  status: r.totalPaid >= r.totalDue ? "PAID" : "PENDING", carriedPrincipalDue: r.carriedPrincipalDue, carriedInterestDue: r.carriedInterestDue,
}))
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

describe("a loan change on a balloon loan", () => {
  it("that changes nothing changes nothing, to the cent", () => {
    const before = loanRows(shape, 3)
    const plan = planInPlace(given(3, { type: "RATE_CHANGE", interestRatePm: 0.04 }))
    expect(plan.rows.map((r) => [r.principalDue, r.interestDue])).toEqual(before.map((r) => [r.principalDue, r.interestDue]))
  })

  it("keeps the balloon on the last row through a new rate, a longer term and a holiday, and reconciles", () => {
    for (const change of [{ type: "RATE_CHANGE", interestRatePm: 0.02 }, { type: "TERM_CHANGE", instalments: 18 }, { type: "PAYMENT_HOLIDAY", holidayInstalments: 2 }] as const) {
      const request = given(3, change)
      const plan = planInPlace(request)
      reconciles(request, plan)
      expect(plan.rows.at(-1)!.principalDue).toBeGreaterThan(balloon)
      expect(Math.max(...plan.fresh.slice(0, -1).map((r) => r.principalDue))).toBeLessThan(balloon)
    }
  })

  it("with a single row left clears everything on it", () => {
    const request = given(11, { type: "RATE_CHANGE", interestRatePm: 0.02 }, at("2026-12-20"))
    const plan = planInPlace(request)
    reconciles(request, plan)
    expect(plan.fresh).toHaveLength(1)
  })

  it("rescheduled with arrears spreads them evenly, and the balloon stays on the last row", () => {
    const request = given(1, { type: "RESCHEDULE", firstDueDate: "2026-05-15" })
    const plan = planInPlace(request)
    reconciles(request, plan)
    const movedPerRow = plan.fresh[0]!.carriedPrincipalDue
    expect(movedPerRow).toBeGreaterThan(0)
    expect(plan.fresh.at(-1)!.principalDue).toBeGreaterThan(balloon)
    expect(plan.fresh.at(-1)!.principalDue - plan.fresh.at(-1)!.carriedPrincipalDue).toBe(loanRows(shape).at(-1)!.principalDue)
  })
})

describe("repricing a loan a change has carried onto", () => {
  const rescheduled = () => planInPlace(given(1, { type: "RESCHEDULE", firstDueDate: "2026-05-15" }))
  const reprice = (rows: StoredRow[], newRatePm: number) => planReprice({ rows, startDate: START, frequency: "MONTHLY", structure: "BALLOON", balloonCents: balloon, newRatePm, effectiveDate: "2026-04-20", today: "2026-04-20" })!

  it("prices only the principal that bears interest: moved arrears stay on their rows, free of interest", () => {
    const rows = stored(rescheduled().rows)
    const plan = reprice(rows, 0.05)
    const updated = new Map(plan.updates.map((u) => [u.id, u]))
    expect(plan.updates.length).toBeGreaterThan(0)
    const before = rows.filter((r) => updated.has(r.id))
    expect(sum(plan.updates.map((u) => u.principalDue))).toBe(sum(before.map((r) => r.principalDue)))
    const moved = sum(before.map((r) => r.carriedPrincipalDue ?? 0))
    expect(moved).toBeGreaterThan(0)
    const bearing = sum(before.map((r) => r.principalDue)) - moved
    expect(plan.updates[0]!.interestDue - (before[0]!.carriedInterestDue ?? 0)).toBe(Math.round(bearing * 0.05))
  })

  it("never brings a row's interest below what was carried onto it, whatever the rate", () => {
    const rows = stored(rescheduled().rows)
    const plan = reprice(rows, 0)
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const u of plan.updates) {
      expect(u.interestDue).toBe(byId.get(u.id)!.carriedInterestDue)
      expect(u.principalDue).toBeGreaterThanOrEqual(byId.get(u.id)!.carriedPrincipalDue ?? 0)
    }
    expect(plan.updates.some((u) => u.interestDue > 0)).toBe(true)
  })

  it("keeps the interest a holiday deferred, and the balloon on the last row", () => {
    const holiday = planInPlace(given(3, { type: "PAYMENT_HOLIDAY", holidayInstalments: 2 }))
    const rows = stored(holiday.rows)
    const plan = reprice(rows, 0.02)
    const last = plan.updates.at(-1)!
    expect(last.principalDue).toBeGreaterThan(balloon)
    expect(sum(plan.updates.map((u) => u.principalDue))).toBe(sum(rows.filter((r) => plan.updates.some((u) => u.id === r.id)).map((r) => r.principalDue)))
    const carried = sum(rows.filter((r) => plan.updates.some((u) => u.id === r.id)).map((r) => r.carriedInterestDue ?? 0))
    expect(carried).toBeGreaterThan(0)
    expect(sum(plan.updates.map((u) => u.interestDue))).toBeGreaterThan(carried)
  })

  it("has nothing to price when only moved principal is left", () => {
    const rows = stored(rescheduled().rows).map((r) => ({ ...r, carriedPrincipalDue: r.principalDue }))
    expect(planReprice({ rows, startDate: START, frequency: "MONTHLY", structure: "BALLOON", balloonCents: balloon, newRatePm: 0.05, effectiveDate: "2026-04-20", today: "2026-04-20" })).toBeNull()
  })
})
