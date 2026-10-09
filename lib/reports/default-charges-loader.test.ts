import { describe, expect, it } from "vitest"
import {
  boardPackChargesSummary,
  parseExemptionAudit,
  parseRefundSplitAudit,
  refundDueRows,
  type DefaultChargesReport,
} from "./default-charges-loader"
import { chargesOwingByBand } from "./charges-owing"

const d = (iso: string) => new Date(iso)

describe("audit parsing (the shapes lib/loan/refund-excess.ts and the exemption route write)", () => {
  it("reads a refund-due split", () => {
    expect(parseRefundSplitAudit({
      createdAt: d("2026-09-16T08:00:00Z"),
      newValue: { amount: 0, refundDueCents: 8_000, refundPaymentId: "pay-child", reason: "x", loanId: "loan-1" },
    })).toEqual({ at: d("2026-09-16T08:00:00Z"), loanId: "loan-1", cents: 8_000, refundPaymentId: "pay-child" })
  })

  it("treats a malformed refund row as nothing, never as money", () => {
    expect(parseRefundSplitAudit({ createdAt: d("2026-09-16T08:00:00Z"), newValue: null }))
      .toMatchObject({ loanId: null, cents: 0, refundPaymentId: null })
  })

  it("reads an exemption change from both sides", () => {
    expect(parseExemptionAudit({ oldValue: { defaultChargesExempt: false }, newValue: { defaultChargesExempt: true } }))
      .toEqual({ from: false, to: true })
    expect(parseExemptionAudit({ oldValue: { defaultChargesExempt: true }, newValue: { defaultChargesExempt: false } }))
      .toEqual({ from: true, to: false })
  })
})

describe("refundDueRows", () => {
  const payment = (id: string, receivedAt: string) => ({
    id, amount: 8_000, receivedAt: d(receivedAt), loanId: "loan-1",
    loan: { reference: "LN-1", client: { firstName: "Thandi", lastName: "Mthembu" } },
  })

  it("labels an exemption refund and dates it from the exemption, not the receipt", () => {
    const [row] = refundDueRows([payment("pay-child", "2026-08-01T08:00:00Z")], [
      { at: d("2026-09-16T08:00:00Z"), loanId: "loan-1", cents: 8_000, refundPaymentId: "pay-child" },
    ])
    expect(row).toMatchObject({ source: "exemption", dueSince: d("2026-09-16T08:00:00Z"), clientName: "Thandi Mthembu" })
  })

  it("labels any other refund-due receipt an over-payment, due since it was received", () => {
    const [row] = refundDueRows([payment("pay-over", "2026-08-01T08:00:00Z")], [
      { at: d("2026-09-16T08:00:00Z"), loanId: "loan-1", cents: 8_000, refundPaymentId: "pay-child" },
    ])
    expect(row).toMatchObject({ source: "over-payment", dueSince: d("2026-08-01T08:00:00Z") })
  })
})

describe("boardPackChargesSummary", () => {
  const now = d("2026-09-26T10:00:00+02:00")
  const report = (state: DefaultChargesReport["state"]): DefaultChargesReport => ({
    state, startedAt: d("2026-09-01T08:00:00Z"), stoppedAt: null, rows: [],
    months: [{
      month: "2026-09", interest: 0, fees: 0, letters: 0, accrued: 30_000, collected: 10_000, waived: 0,
      // Deliberately not book + settled: the settled figure must be read, never derived from this.
      outstanding: 99_999, exemptionsSet: 0, exemptionsLifted: 0, refundDue: 0,
    }],
    refundsDue: [
      { paymentId: "a", loanId: "l", loanReference: "LN", clientName: "C", amount: 500, receivedAt: now, dueSince: now, source: "exemption" },
      { paymentId: "b", loanId: "l", loanReference: "LN", clientName: "C", amount: 9_999, receivedAt: now, dueSince: now, source: "over-payment" },
    ],
  })
  // R120 in arrears bands, R30 on a paid-up loan; R50 read from the written-off and closed loans.
  const owing = chargesOwingByBand([{ daysInArrears: 10, chargesOutstanding: 12_000 }, { daysInArrears: 0, chargesOutstanding: 3_000 }], true)

  it("ties the owing figures to the board pack's bands and states the settled loans' figure as read", () => {
    expect(boardPackChargesSummary(report("live"), owing, 5_000, now)).toEqual({
      accrued: 30_000, collected: 10_000,
      owingInBands: 12_000, owingNotInArrears: 3_000, owingElsewhere: 5_000,
      exemptionRefunds: { count: 1, amount: 500 },
    })
  })

  it("is null unless charges are live", () => {
    expect(boardPackChargesSummary(report("never"), owing, 5_000, now)).toBeNull()
    expect(boardPackChargesSummary(report("stopped"), owing, 5_000, now)).toBeNull()
  })
})
