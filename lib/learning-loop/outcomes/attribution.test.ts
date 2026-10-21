import { describe, expect, it } from "vitest"
import { finalApproval, takeUpOutcomes, type ApplicationState, type DecisionRef } from "./attribution"

const at = (iso: string) => new Date(`${iso}T09:00:00+02:00`)
let n = 0
const rec = (kind: DecisionRef["kind"], decision: string, day: string): DecisionRef =>
  ({ id: `rec-${++n}-${decision}`, kind, decision, applicationId: "app-1", decidedAt: at(day), createdAt: at(day) })
const app = (over: Partial<ApplicationState> = {}): ApplicationState =>
  ({ id: "app-1", status: "APPROVED", disbursedAt: null, updatedAt: at("2026-03-01"), ...over })

describe("finalApproval", () => {
  it("is the latest approval at or before disbursement; an approval undone by a return gets nothing", () => {
    const first = rec("CREDIT_DECISION", "APPROVE", "2026-01-05")
    const returned = rec("CREDIT_DECISION", "RETURN_TO_REVIEW", "2026-01-06")
    const second = rec("CREDIT_DECISION", "APPROVE", "2026-01-07")
    const afterPayout = rec("CREDIT_DECISION", "APPROVE", "2026-01-20")
    expect(finalApproval([second, first, returned, afterPayout], at("2026-01-10"))?.id).toBe(second.id)
  })

  it("ignores offers, flags cleared and declines", () => {
    const records = [rec("OFFER", "APPROVED_TERMS", "2026-01-05"), rec("CREDIT_DECISION", "CLEAR_FLAG", "2026-01-04"), rec("CREDIT_DECISION", "DECLINE", "2026-01-03")]
    expect(finalApproval(records, at("2026-01-10"))).toBeNull()
  })

  it("is null when no approval was logged before the loan was paid out", () => {
    expect(finalApproval([rec("CREDIT_DECISION", "APPROVE", "2026-02-01")], at("2026-01-10"))).toBeNull()
  })
})

describe("takeUpOutcomes", () => {
  const offer = rec("OFFER", "APPROVED_TERMS", "2026-01-05")
  const pasq = rec("OFFER", "QUOTATION_ISSUED", "2026-01-06")
  const state = (rows: ReturnType<typeof takeUpOutcomes>) => rows.map((r) => [r.decisionRecordId, r.outcomeKind, r.window, r.state, r.value])

  it("is TAKEN_UP true for every offer of a disbursed application", () => {
    const rows = takeUpOutcomes([offer, pasq], app({ status: "DISBURSED", disbursedAt: at("2026-01-08") }))
    expect(state(rows)).toEqual([[offer.id, "TAKEN_UP", "OFFER", "OBSERVED", true], [pasq.id, "TAKEN_UP", "OFFER", "OBSERVED", true]])
    expect(rows[0].sourceRef).toBe("app-1")
    expect(rows[0].observedAt).toEqual(at("2026-01-08"))
  })

  it("is false for an offer a return ended, true for the offer that followed and was disbursed", () => {
    const returned = rec("CREDIT_DECISION", "RETURN_TO_DRAFT", "2026-01-06")
    const reOffer = rec("OFFER", "APPROVED_TERMS", "2026-01-07")
    const rows = takeUpOutcomes([offer, returned, reOffer], app({ status: "DISBURSED", disbursedAt: at("2026-01-09") }))
    expect(state(rows)).toEqual([[offer.id, "TAKEN_UP", "OFFER", "OBSERVED", false], [reOffer.id, "TAKEN_UP", "OFFER", "OBSERVED", true]])
    expect(rows[0].observedAt).toEqual(returned.decidedAt)
  })

  it("is false when the application was declined or cancelled without a loan", () => {
    expect(state(takeUpOutcomes([offer], app({ status: "CANCELLED" })))).toEqual([[offer.id, "TAKEN_UP", "OFFER", "OBSERVED", false]])
    expect(state(takeUpOutcomes([offer, rec("CREDIT_DECISION", "DECLINE", "2026-01-09")], app({ status: "DECLINED" }))))
      .toEqual([[offer.id, "TAKEN_UP", "OFFER", "OBSERVED", false]])
  })

  it("is PENDING while the approved application awaits signing and payout", () => {
    expect(state(takeUpOutcomes([offer], app()))).toEqual([[offer.id, "TAKEN_UP", "OFFER", "PENDING", null]])
  })

  it("gives credit decisions no take-up row", () => {
    expect(takeUpOutcomes([rec("CREDIT_DECISION", "APPROVE", "2026-01-05")], app())).toEqual([])
  })
})
