import { describe, expect, it } from "vitest"
import { debitDateOnOrAfter, earliestActionDate, planInstructions, type PlanRow } from "./schedule"

describe("debitDateOnOrAfter", () => {
  it("takes the debit day of the month, rolling a weekend forward to the next business day", () => {
    // 25 Oct 2026 is a Sunday.
    expect(debitDateOnOrAfter("2026-10-20", 25)).toBe("2026-10-26")
  })

  it("keeps a debit day already rolled past a weekend: the 25th on a Sunday is still collected on Monday the 26th", () => {
    expect(debitDateOnOrAfter("2026-10-26", 25)).toBe("2026-10-26")
  })

  it("takes last month's debit day when it rolled into this month", () => {
    // 31 Oct 2026 is a Saturday: October's collection falls on Monday 2 Nov.
    expect(debitDateOnOrAfter("2026-11-01", 31)).toBe("2026-11-02")
  })

  it("moves to next month when the day has passed", () => {
    expect(debitDateOnOrAfter("2026-10-27", 25)).toBe("2026-11-25")
  })

  it("clamps a day the month does not have to its last day", () => {
    expect(debitDateOnOrAfter("2026-11-03", 31)).toBe("2026-11-30")
  })

  it("rolls past a public holiday", () => {
    // 16 Dec 2026 (Day of Reconciliation) is a Wednesday.
    expect(debitDateOnOrAfter("2026-12-01", 16)).toBe("2026-12-17")
  })
})

describe("earliestActionDate", () => {
  it("is the submission lead in business days after today", () => {
    expect(earliestActionDate("2026-10-14")).toBe("2026-10-16")
    expect(earliestActionDate("2026-10-15")).toBe("2026-10-19")
  })
})

const mandate = { debitDay: 25, maxAmountCents: 150_000, firstCollectionDate: "2026-10-01" }
const row = (patch: Partial<PlanRow>): PlanRow => ({
  id: "r1", installmentNo: 1, dueOn: "2026-10-25", totalDue: 100_000, totalPaid: 0, status: "PENDING",
  presentments: [], lastResolvedOn: null, ...patch,
})

describe("planInstructions", () => {
  it("plans the first presentment of an instalment due inside the horizon, never before its due date", () => {
    expect(planInstructions({ mandate, today: "2026-10-20", rows: [row({})] })).toEqual([
      { repaymentScheduleId: "r1", installmentNo: 1, presentmentNo: 1, amountCents: 100_000, actionDate: "2026-10-26" },
    ])
  })

  it("leaves an instalment beyond the horizon for a later run", () => {
    expect(planInstructions({ mandate, today: "2026-10-20", rows: [row({ dueOn: "2026-11-25" })] })).toEqual([])
  })

  it("collects only what is still outstanding, capped at the mandate maximum", () => {
    const plan = planInstructions({
      mandate,
      today: "2026-10-20",
      rows: [
        row({ id: "a", totalDue: 100_000, totalPaid: 40_000, status: "PARTIAL" }),
        row({ id: "b", installmentNo: 2, totalDue: 200_000 }),
      ],
    })
    expect(plan.map((p) => [p.repaymentScheduleId, p.amountCents])).toEqual([["a", 60_000], ["b", 150_000]])
  })

  it("skips paid, written-off and fully paid instalments", () => {
    const plan = planInstructions({
      mandate,
      today: "2026-10-20",
      rows: [
        row({ id: "a", status: "PAID", totalPaid: 100_000 }),
        row({ id: "b", status: "WRITTEN_OFF" }),
        row({ id: "c", totalPaid: 100_000 }),
      ],
    })
    expect(plan).toEqual([])
  })

  it("plans an overdue, never-presented instalment at the first debit day the lead time allows", () => {
    // Due 25 Sep, mandate set up 20 Oct: earliest 22 Oct, next debit day 26 Oct.
    const plan = planInstructions({ mandate, today: "2026-10-20", rows: [row({ dueOn: "2026-09-25" })] })
    expect(plan[0].actionDate).toBe("2026-10-26")
  })

  it("re-presents an NPF once, on the next debit day after the unpaid came back", () => {
    const presented = row({
      presentments: [{ presentmentNo: 1, status: "UNPAID", reasonCode: "INSUFFICIENT_FUNDS" }],
      lastResolvedOn: "2026-10-26",
    })
    expect(planInstructions({ mandate, today: "2026-11-15", rows: [presented] })).toEqual([
      { repaymentScheduleId: "r1", installmentNo: 1, presentmentNo: 2, amountCents: 100_000, actionDate: "2026-11-25" },
    ])
  })

  it("never plans a third presentment", () => {
    const twice = row({
      presentments: [
        { presentmentNo: 1, status: "UNPAID", reasonCode: "INSUFFICIENT_FUNDS" },
        { presentmentNo: 2, status: "UNPAID", reasonCode: "INSUFFICIENT_FUNDS" },
      ],
      lastResolvedOn: "2026-11-25",
    })
    expect(planInstructions({ mandate, today: "2026-12-15", rows: [twice] })).toEqual([])
  })

  it("does not collect before the mandate's first collection date", () => {
    const plan = planInstructions({
      mandate: { ...mandate, firstCollectionDate: "2026-11-01" },
      today: "2026-10-20",
      rows: [row({})],
    })
    expect(plan).toEqual([])
  })
})
