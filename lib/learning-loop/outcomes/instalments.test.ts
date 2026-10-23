import { describe, expect, it } from "vitest"
import type { InstalmentFact } from "./facts"
import { lateOutcome, paidOutcome, returnedDebitOrderOutcome } from "./instalments"

const due = "2026-03-31"
const inst = (paidDay: string | null, paidInFull = paidDay !== null): InstalmentFact =>
  ({ ref: "sched-3", installmentNo: 3, dueDay: due, totalDueCents: 100_000, paidInFull, paidDay })
const pick = (r: { state: string; value: boolean | null; reasonCode: string | null }) => [r.state, r.value, r.reasonCode]

describe("PAID: settled in full by the due date", () => {
  it("is PENDING on and before the due day, even when already paid", () => {
    expect(pick(paidOutcome(inst("2026-03-20"), due))).toEqual(["PENDING", null, null])
  })

  it("is true when paid on the due day, and dated the day it was paid", () => {
    const row = paidOutcome(inst(due), "2026-04-01")
    expect(pick(row)).toEqual(["OBSERVED", true, null])
    expect(row.window).toBe("INSTALMENT:3")
    expect(row.sourceRef).toBe("sched-3")
    expect(row.amountCents).toBe(100_000)
    expect(row.observedAt).toEqual(new Date("2026-03-31T00:00:00+02:00"))
  })

  it("is false when paid a day late or not at all", () => {
    expect(pick(paidOutcome(inst("2026-04-01"), "2026-04-02"))).toEqual(["OBSERVED", false, null])
    expect(pick(paidOutcome(inst(null), "2026-04-01"))).toEqual(["OBSERVED", false, null])
  })

  it("is false when only partly paid by the due day", () => {
    expect(pick(paidOutcome({ ...inst(null), paidInFull: false }, "2026-04-01"))).toEqual(["OBSERVED", false, null])
  })

  it("is UNOBSERVABLE, never good, when paid in full with no payment date", () => {
    expect(pick(paidOutcome(inst(null, true), "2026-04-01"))).toEqual(["UNOBSERVABLE", null, "PAID_AT_MISSING"])
  })
})

describe("LATE: paid after the due date, before 30 DPD", () => {
  it("is PENDING until 30 days after the due day", () => {
    expect(pick(lateOutcome(inst("2026-04-05"), "2026-04-29"))).toEqual(["PENDING", null, null])
  })

  it("is true for a payment 1 to 29 days late", () => {
    expect(pick(lateOutcome(inst("2026-04-01"), "2026-04-30"))).toEqual(["OBSERVED", true, null])
    expect(pick(lateOutcome(inst("2026-04-29"), "2026-04-30"))).toEqual(["OBSERVED", true, null])
  })

  it("is false on time, at 30+ DPD, and unpaid", () => {
    expect(pick(lateOutcome(inst(due), "2026-04-30"))).toEqual(["OBSERVED", false, null])
    expect(pick(lateOutcome(inst("2026-04-30"), "2026-05-01"))).toEqual(["OBSERVED", false, null])
    expect(pick(lateOutcome(inst(null), "2026-04-30"))).toEqual(["OBSERVED", false, null])
  })

  it("is UNOBSERVABLE when paid with no payment date", () => {
    expect(pick(lateOutcome(inst(null, true), "2026-05-30"))).toEqual(["UNOBSERVABLE", null, "PAID_AT_MISSING"])
  })
})

describe("RETURNED_DEBIT_ORDER", () => {
  it.each(["INSUFFICIENT_FUNDS", "PAYMENT_STOPPED", "ACCOUNT_CLOSED", "MANDATE_SUSPENDED", "UNKNOWN", null])("keeps reason %s exactly", (reasonCode) => {
    const resolvedAt = new Date("2026-04-02T09:00:00+02:00")
    const row = returnedDebitOrderOutcome({ ref: "result-1", installmentNo: 3, amountCents: 100_000, reasonCode, resolvedAt })
    expect(row).toEqual({
      outcomeKind: "RETURNED_DEBIT_ORDER", window: "INSTALMENT:3", sourceRef: "result-1",
      state: "OBSERVED", value: true, observedAt: resolvedAt, amountCents: 100_000, reasonCode,
    })
  })
})
