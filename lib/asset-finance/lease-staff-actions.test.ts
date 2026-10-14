import { describe, expect, it } from "vitest"
import {
  canAcceptQuote, canElect, canRecordReading, canRequestQuote, canSubmitClaim, claimActions, nextEndStep, type EndOfTermState,
} from "./lease-staff-actions"

const eot = (over: Partial<EndOfTermState>): EndOfTermState => ({
  outcome: "RETURN", status: "ELECTED", extensionNoticeOn: null, extensionEndsOn: null, natisRequired: false, natisConfirmed: false, ...over,
})
const TODAY = "2030-06-15"

describe("nextEndStep", () => {
  it("offers the inspection after a return is elected, then the invoice, then nothing", () => {
    expect(nextEndStep(eot({}), TODAY)).toEqual({ step: "inspection", needs: "manage" })
    expect(nextEndStep(eot({ status: "INSPECTED" }), TODAY)).toEqual({ step: "invoice", needs: "decide" })
    expect(nextEndStep(eot({ status: "INVOICED" }), TODAY)).toBeNull()
    expect(nextEndStep(eot({ status: "COMPLETED" }), TODAY)).toBeNull()
  })

  it("invoices a purchase straight after the election and asks for the eNaTIS change only on a registered asset", () => {
    expect(nextEndStep(eot({ outcome: "PURCHASE" }), TODAY)).toEqual({ step: "invoice", needs: "decide" })
    expect(nextEndStep(eot({ outcome: "PURCHASE", status: "INVOICED", natisRequired: true }), TODAY)).toEqual({ step: "natis-confirmed", needs: "decide" })
    expect(nextEndStep(eot({ outcome: "PURCHASE", status: "INVOICED", natisRequired: true, natisConfirmed: true }), TODAY)).toBeNull()
    expect(nextEndStep(eot({ outcome: "PURCHASE", status: "INVOICED", natisRequired: false }), TODAY)).toBeNull()
  })

  it("walks a month-to-month extension: notice, wait for its end date, then the inspection", () => {
    const extending = eot({ outcome: "EXTEND", status: "EXTENDING" })
    expect(nextEndStep(extending, TODAY)).toEqual({ step: "extension-notice", needs: "manage" })
    expect(nextEndStep({ ...extending, extensionNoticeOn: "2030-06-01", extensionEndsOn: "2030-07-01" }, TODAY)).toBeNull()
    expect(nextEndStep({ ...extending, extensionNoticeOn: "2030-05-01", extensionEndsOn: "2030-06-15" }, TODAY)).toEqual({ step: "inspection", needs: "manage" })
  })
})

describe("canElect", () => {
  const open = { loanStatus: "ACTIVE", hasEndOfTerm: false, windowOpen: true, canManage: true }
  it("needs an open window, no earlier election and the permission", () => {
    expect(canElect(open)).toBe(true)
    expect(canElect({ ...open, windowOpen: false })).toBe(false)
    expect(canElect({ ...open, hasEndOfTerm: true })).toBe(false)
    expect(canElect({ ...open, canManage: false })).toBe(false)
    expect(canElect({ ...open, loanStatus: "COMPLETED" })).toBe(true)
    expect(canElect({ ...open, loanStatus: "WRITTEN_OFF" })).toBe(false)
  })
})

describe("claimActions", () => {
  const me = { userId: "u-me", canDecide: true }
  const submitted = { status: "SUBMITTED" as const, submittedById: "u-other", firstApprovedById: null }
  it("lets a different decider approve or reject a submitted claim", () => {
    expect(claimActions(submitted, me)).toEqual({ approve: true, reject: true, paid: false, hint: null })
  })
  it("withholds approval from the submitter and from the first approver, saying why", () => {
    const own = claimActions({ ...submitted, submittedById: "u-me" }, me)
    expect(own).toMatchObject({ approve: false, reject: true })
    expect(own.hint).toContain("submitted")
    const first = claimActions({ ...submitted, firstApprovedById: "u-me" }, me)
    expect(first).toMatchObject({ approve: false, reject: true })
    expect(first.hint).toContain("second")
  })
  it("marks only an approved claim paid, and shows nothing without the decide permission or once decided", () => {
    expect(claimActions({ ...submitted, status: "APPROVED" }, me)).toMatchObject({ paid: true, approve: false, reject: false })
    expect(claimActions(submitted, { ...me, canDecide: false })).toEqual({ approve: false, reject: false, paid: false, hint: null })
    expect(claimActions({ ...submitted, status: "PAID" }, me).paid).toBe(false)
    expect(claimActions({ ...submitted, status: "REJECTED" }, me).reject).toBe(false)
  })
})

describe("canSubmitClaim, canRecordReading, quotes", () => {
  it("allows a claim on a running lease inside its term with an unsettled fund", () => {
    const ok = { loanStatus: "ACTIVE", today: TODAY, leaseEndDate: "2030-06-15", fundSettled: false, canManage: true }
    expect(canSubmitClaim(ok)).toBe(true)
    expect(canSubmitClaim({ ...ok, today: "2030-06-16" })).toBe(false)
    expect(canSubmitClaim({ ...ok, fundSettled: true })).toBe(false)
    expect(canSubmitClaim({ ...ok, loanStatus: "COMPLETED" })).toBe(false)
  })
  it("records readings until the end of term is invoiced", () => {
    const ok = { loanStatus: "ACTIVE", unitContracted: true, endStatus: null, canManage: true } as const
    expect(canRecordReading(ok)).toBe(true)
    expect(canRecordReading({ ...ok, endStatus: "ELECTED" })).toBe(true)
    expect(canRecordReading({ ...ok, endStatus: "INVOICED" })).toBe(false)
    expect(canRecordReading({ ...ok, unitContracted: false })).toBe(false)
  })
  it("requests a quote only while no end of term exists, and accepts only a live quote", () => {
    expect(canRequestQuote({ loanStatus: "ACTIVE", hasEndOfTerm: false, canManage: true })).toBe(true)
    expect(canRequestQuote({ loanStatus: "ACTIVE", hasEndOfTerm: true, canManage: true })).toBe(false)
    const quote = { quoteStatus: "QUOTED", validUntil: "2030-06-15", today: TODAY, loanStatus: "ACTIVE", hasEndOfTerm: false, canDecide: true } as const
    expect(canAcceptQuote(quote)).toBe(true)
    expect(canAcceptQuote({ ...quote, today: "2030-06-16" })).toBe(false)
    expect(canAcceptQuote({ ...quote, quoteStatus: "ACCEPTED" })).toBe(false)
    expect(canAcceptQuote({ ...quote, canDecide: false })).toBe(false)
  })
})
