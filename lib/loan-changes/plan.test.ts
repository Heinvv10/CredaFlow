import { describe, expect, it } from "vitest"
import { addCalendarMonths } from "@/lib/product-engine/periods"
import { planInPlace, planNewLoan, spreadCarried, type PlanInput, type PlanRow } from "./plan"

const DAY = 86_400_000
/** The instant of a SAST day at noon: dates here are fixed, so the suite is independent of the day it runs. */
const at = (day: string) => new Date(`${day}T10:00:00.000Z`)
const START = at("2026-01-15")

function row(no: number, over: Partial<PlanRow> = {}): PlanRow {
  const base = { id: `r${no}`, installmentNo: no, dueDate: addCalendarMonths(START, no), principalDue: 100_000, interestDue: 10_000, feesDue: 5_000, totalPaid: 0, paidAt: null as Date | null }
  const merged = { ...base, ...over }
  return { ...merged, totalDue: over.totalDue ?? merged.principalDue + merged.interestDue + merged.feesDue }
}

const paid = (r: PlanRow): PlanRow => ({ ...r, totalPaid: r.totalDue, paidAt: r.dueDate })

const base = (rows: PlanRow[], over: Partial<PlanInput> = {}): PlanInput => ({
  loan: { principal: rows.reduce((s, r) => s + r.principalDue, 0), interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 5_000, startDate: START },
  rows, frequency: "MONTHLY", structure: "AMORTISING", asOf: at("2026-04-20"),
  change: { type: "RATE_CHANGE", interestRatePm: 0.03 },
  ...over,
})

function reconciles(input: PlanInput, plan: ReturnType<typeof planInPlace>) {
  const rows = plan.rows
  expect(rows.reduce((s, r) => s + r.principalDue, 0)).toBe(input.loan.principal)
  expect(rows.reduce((s, r) => s + r.interestDue, 0)).toBe(plan.totalInterest)
  expect(rows.reduce((s, r) => s + r.totalDue, 0)).toBe(plan.totalRepayable)
  for (const r of rows) {
    expect(r.totalDue).toBe(r.principalDue + r.interestDue + r.feesDue)
    for (const value of [r.principalDue, r.interestDue, r.feesDue, r.totalDue]) expect(Number.isInteger(value) && value >= 0).toBe(true)
  }
}

describe("planInPlace", () => {
  const sixRows = [paid(row(1)), paid(row(2)), paid(row(3)), row(4), row(5), row(6)]

  it("keeps paid rows untouched and reschedules only the unpaid principal", () => {
    const plan = planInPlace(base(sixRows))
    expect(plan.keep.map((r) => r.id)).toEqual(["r1", "r2", "r3"])
    expect(plan.remove).toEqual(["r4", "r5", "r6"])
    expect(plan.trim).toEqual([])
    expect(plan.balance).toBe(300_000)
    expect(plan.fresh.map((r) => r.installmentNo)).toEqual([4, 5, 6])
    expect(plan.fresh.reduce((s, r) => s + r.principalDue, 0)).toBe(300_000)
    reconciles(base(sixRows), plan)
  })

  it("keeps the dates of the instalments a rate change does not move", () => {
    const plan = planInPlace(base(sixRows))
    expect(plan.fresh.map((r) => r.dueDate)).toEqual([row(4).dueDate, row(5).dueDate, row(6).dueDate])
  })

  it("charges a new rate on the balance", () => {
    const plan = planInPlace(base(sixRows))
    expect(plan.fresh[0]!.interestDue).toBe(9_000) // 3% of 300 000.00
  })

  it("splits a part-paid row that fell due on what the receipts paid: interest, then fees, then principal", () => {
    const rows = [paid(row(1)), paid(row(2)), { ...row(3), totalPaid: 20_000 }, row(4), row(5), row(6)]
    const plan = planInPlace(base(rows))
    expect(plan.trim).toEqual([expect.objectContaining({ id: "r3", principalDue: 5_000, interestDue: 10_000, feesDue: 5_000, totalDue: 20_000, totalPaid: 20_000 })])
    expect(plan.balance).toBe(395_000)
    reconciles(base(rows), plan)
  })

  it("a due row part-paid inside its interest keeps no principal, and what it still owes is carried", () => {
    const rows = [paid(row(1)), paid(row(2)), { ...row(3), totalPaid: 3_000 }, row(4), row(5), row(6)]
    const plan = planInPlace(base(rows))
    expect(plan.trim[0]).toMatchObject({ principalDue: 0, interestDue: 3_000, feesDue: 0, totalDue: 3_000 })
    expect(plan.carriedInterest).toBe(7_000)
    expect(plan.carriedFees).toBe(5_000)
    reconciles(base(rows), plan)
  })

  it("money paid ahead on a row not yet due lowers the balance: it is not interest the borrower pays twice", () => {
    const rows = [paid(row(1)), paid(row(2)), paid(row(3)), { ...row(4), totalPaid: 30_000 }, row(5), row(6)]
    const plan = planInPlace(base(rows))
    expect(plan.trim[0]).toMatchObject({ principalDue: 30_000, interestDue: 0, feesDue: 0 })
    expect(plan.balance).toBe(270_000)
    expect(plan.fresh[0]!.interestDue).toBe(8_100) // 3% of 270 000.00
    reconciles(base(rows), plan)
  })

  it("carries interest and fees already due into the new rows without adding them to the balance", () => {
    const rows = [paid(row(1)), row(2), row(3), row(4), row(5), row(6)] // 2 and 3 are overdue on 20 April
    const plan = planInPlace(base(rows))
    expect(plan.carriedInterest).toBe(20_000)
    expect(plan.carriedFees).toBe(10_000)
    expect(plan.balance).toBe(500_000)
    expect(plan.fresh.reduce((s, r) => s + r.interestDue, 0)).toBe(plan.scheduleInterest + 20_000)
    reconciles(base(rows), plan)
  })

  it("drops the unearned interest of rows not yet due", () => {
    const plan = planInPlace(base(sixRows))
    expect(plan.carriedInterest).toBe(0)
    expect(plan.carriedFees).toBe(0)
  })

  it("every new row falls after the day of the change, so arrears clear", () => {
    const rows = [paid(row(1)), row(2), row(3), row(4), row(5), row(6)]
    const plan = planInPlace(base(rows))
    expect(plan.fresh.every((r) => r.dueDate.getTime() > at("2026-04-20").getTime())).toBe(true)
    expect(plan.arrearsAmount).toBe(0)
    expect(plan.daysInArrears).toBe(0)
  })

  it("a term change sets the number of remaining instalments", () => {
    const input = base(sixRows, { change: { type: "TERM_CHANGE", instalments: 12 } })
    const plan = planInPlace(input)
    expect(plan.fresh).toHaveLength(12)
    expect(plan.maturityDate).toEqual(plan.fresh[11]!.dueDate)
    reconciles(input, plan)
  })

  it("a payment holiday leaves the holiday's periods empty and the interest deferred, not compounded", () => {
    const input = base(sixRows, { change: { type: "PAYMENT_HOLIDAY", holidayInstalments: 2 } })
    const plan = planInPlace(input)
    expect(plan.fresh).toHaveLength(3)
    // No instalment in May or June; the first is three periods after the last due date.
    expect(plan.fresh[0]!.dueDate).toEqual(addCalendarMonths(START, 6))
    expect(plan.terms).toMatchObject({ graceKind: "FULL", graceInstalments: 2, instalments: 5 })
    expect(plan.deferredInterest).toBe(24_000) // 2 periods x 4% of 300 000.00, simple interest
    reconciles(input, plan)
  })

  it("a reschedule moves the first date and charges the extra days as simple interest", () => {
    const input = base(sixRows, { change: { type: "RESCHEDULE", firstDueDate: "2026-05-30" } })
    const plan = planInPlace(input)
    expect(plan.fresh).toHaveLength(3)
    expect(plan.fresh[0]!.dueDate.toISOString().slice(0, 10)).toBe("2026-05-30")
    expect(plan.carriedInterest).toBe(6_000) // 15 days at 4% a 30-day month on 300 000.00
    reconciles(input, plan)
  })

  it("a reschedule to a month end keeps the day it was asked for, across short months", () => {
    const rows = [paid(row(1)), row(2)] // next instalment 15 March
    const input = base(rows, { asOf: at("2026-02-20"), change: { type: "RESCHEDULE", firstDueDate: "2026-03-31" } })
    expect(planInPlace(input).fresh[0]!.dueDate.toISOString().slice(0, 10)).toBe("2026-03-31")
  })

  it("refuses a reschedule to before the next instalment", () => {
    expect(() => planInPlace(base(sixRows, { change: { type: "RESCHEDULE", firstDueDate: "2026-05-01" } }))).toThrow(/next instalment/)
  })

  it("restructure takes rate and term together", () => {
    const input = base(sixRows, { change: { type: "RESTRUCTURE", interestRatePm: 0.02, instalments: 24 } })
    const plan = planInPlace(input)
    expect(plan.interestRatePm).toBe(0.02)
    expect(plan.fresh).toHaveLength(24)
    reconciles(input, plan)
  })

  it("keeps a fully prepaid future row and starts after it", () => {
    const rows = [paid(row(1)), paid(row(2)), paid(row(3)), paid(row(4)), paid(row(5)), row(6)]
    const plan = planInPlace(base(rows))
    expect(plan.keep.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5"])
    expect(plan.fresh[0]!.dueDate).toEqual(row(6).dueDate)
  })

  it("weekly terms stay weekly, and a FLAT loan reconciles", () => {
    const rows = [paid(row(1, { dueDate: new Date(START.getTime() + 7 * DAY) })), row(2, { dueDate: new Date(START.getTime() + 14 * DAY) }), row(3, { dueDate: new Date(START.getTime() + 21 * DAY) })]
    const input = base(rows, { frequency: "WEEKLY", asOf: new Date(START.getTime() + 8 * DAY), loan: { ...base(rows).loan, interestModel: "FLAT" }, change: { type: "TERM_CHANGE", instalments: 5 } })
    const plan = planInPlace(input)
    expect(plan.fresh[1]!.dueDate.getTime() - plan.fresh[0]!.dueDate.getTime()).toBe(7 * DAY)
    reconciles(input, plan)
  })

  it("reconciles over a sweep of small balances, high rates and overdue rows", () => {
    for (const unit of [1, 7, 333, 10_001]) {
      for (const rate of [0, 0.01, 0.05, 0.25]) {
        for (const paidRows of [0, 1, 3]) {
          for (const n of [1, 2, 7, 13]) {
            const rows = [1, 2, 3, 4, 5, 6].map((no) => row(no, { principalDue: unit, interestDue: 3, feesDue: no === 1 ? 7 : 0 })).map((r, i) => (i < paidRows ? paid(r) : r))
            const input = base(rows, { loan: { ...base(rows).loan, monthlyServiceFee: 0, interestRatePm: rate }, change: { type: "RESTRUCTURE", interestRatePm: rate, instalments: n } })
            reconciles(input, planInPlace(input))
          }
        }
      }
    }
  })

  it("refuses when nothing of the principal is left", () => {
    const rows = [paid(row(1)), paid(row(2))]
    expect(() => planInPlace(base(rows))).toThrow(/principal/)
  })
})

describe("spreadCarried", () => {
  it("lands every cent on the rows", () => {
    const rows = [row(1), row(2), row(3)].map((r) => ({ ...r, totalPaid: 0 }))
    const out = spreadCarried(rows, 100, 7)
    expect(out.reduce((s, r) => s + r.interestDue, 0)).toBe(30_100)
    expect(out.reduce((s, r) => s + r.feesDue, 0)).toBe(15_007)
    for (const r of out) expect(r.totalDue).toBe(r.principalDue + r.interestDue + r.feesDue)
  })
})

describe("planNewLoan", () => {
  const input = {
    settledCents: 250_012, newMoneyCents: 100_000, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE" as const, monthlyServiceFee: 5_000,
    frequency: "MONTHLY" as const, instalments: 7, asOf: at("2026-04-20"),
  }

  it("a new loan's principal is the settlement plus the new money, to the cent", () => {
    const plan = planNewLoan(input)
    expect(plan.principal).toBe(350_012)
    expect(plan.rows.reduce((s, r) => s + r.principalDue, 0)).toBe(350_012)
    expect(plan.totalRepayable).toBe(plan.rows.reduce((s, r) => s + r.totalDue, 0))
    expect(plan.totalInterest).toBe(plan.rows.reduce((s, r) => s + r.interestDue, 0))
  })

  it("starts today and pays nothing new on a pure refinance", () => {
    const plan = planNewLoan({ ...input, newMoneyCents: 0 })
    expect(plan.principal).toBe(250_012)
    expect(plan.rows[0]!.dueDate).toEqual(addCalendarMonths(at("2026-04-20"), 1))
  })
})
