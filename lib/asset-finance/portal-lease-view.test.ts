import { describe, expect, it, vi } from "vitest"

// ELECTION_WINDOW_MONTHS is read from the module the election route enforces it in; its server-only imports are not under test.
vi.mock("@/lib/audit", () => ({ AuditAction: {}, logAuditStrict: vi.fn() }))
vi.mock("./lease-portal-route", () => ({ clientLeaseRefusal: vi.fn() }))
vi.mock("./meter-readings", () => ({ recordMeterReading: vi.fn() }))

import { canSubmitReading, endOfTermOffer, rentalOutstanding, rentalState, terminationActions } from "./portal-lease-view"

describe("rentalState", () => {
  const row = { cancelled: false, totalCents: 115_000, paidCents: 0, dueDate: "2027-03-01" }
  it("reads paid, partial, overdue, pending and cancelled", () => {
    expect(rentalState({ ...row, paidCents: 115_000 }, "2027-04-01")).toBe("PAID")
    expect(rentalState({ ...row, paidCents: 50_000 }, "2027-02-01")).toBe("PARTIAL")
    expect(rentalState(row, "2027-03-02")).toBe("OVERDUE")
    expect(rentalState(row, "2027-03-01")).toBe("PENDING")
    expect(rentalState({ ...row, cancelled: true }, "2027-03-02")).toBe("CANCELLED")
  })
  it("owes nothing on a cancelled rental and never a negative amount", () => {
    expect(rentalOutstanding({ cancelled: true, totalCents: 115_000, paidCents: 0 })).toBe(0)
    expect(rentalOutstanding({ cancelled: false, totalCents: 115_000, paidCents: 40_000 })).toBe(75_000)
    expect(rentalOutstanding({ cancelled: false, totalCents: 115_000, paidCents: 120_000 })).toBe(0)
  })
})

describe("terminationActions", () => {
  const base = { status: "ACTIVE", endOfTermStarted: false, penaltyConfigured: true, today: "2027-05-10" }
  const quoted = { status: "QUOTED", validUntil: "2027-05-20" } as const

  it("offers a quote request and no accept before any quote", () => {
    expect(terminationActions({ ...base, quote: null })).toEqual({ state: "NONE", canRequest: true, canAccept: false })
  })
  it("offers accept (and a fresh quote) while the quote is valid, up to and including its last day", () => {
    expect(terminationActions({ ...base, quote: quoted })).toEqual({ state: "VALID", canRequest: true, canAccept: true })
    expect(terminationActions({ ...base, today: "2027-05-20", quote: quoted }).canAccept).toBe(true)
  })
  it("withdraws accept once the quote has expired but still lets the lessee ask again", () => {
    expect(terminationActions({ ...base, today: "2027-05-21", quote: quoted })).toEqual({ state: "EXPIRED", canRequest: true, canAccept: false })
  })
  it("offers nothing once a quote is accepted or the end of term has begun", () => {
    expect(terminationActions({ ...base, quote: { status: "ACCEPTED", validUntil: "2027-05-20" } })).toEqual({ state: "ACCEPTED", canRequest: false, canAccept: false })
    expect(terminationActions({ ...base, endOfTermStarted: true, quote: quoted })).toMatchObject({ canRequest: false, canAccept: false })
  })
  it("offers nothing on a closed lease, and no request without a penalty rate", () => {
    expect(terminationActions({ ...base, status: "COMPLETED", quote: quoted })).toMatchObject({ canRequest: false, canAccept: false })
    expect(terminationActions({ ...base, penaltyConfigured: false, quote: null }).canRequest).toBe(false)
  })
})

describe("endOfTermOffer", () => {
  const base = { status: "ACTIVE", lastRentalDate: "2027-12-31", chosen: false, currentValuation: true }

  it("opens six months before the last rental, not a day earlier", () => {
    expect(endOfTermOffer({ ...base, today: "2027-06-29" })).toEqual({ kind: "not_open", opensOn: "2027-06-30" })
    expect(endOfTermOffer({ ...base, today: "2027-06-30" }).kind).toBe("open")
  })
  it("clamps the opening day to a shorter month", () => {
    expect(endOfTermOffer({ ...base, lastRentalDate: "2027-08-31", today: "2027-01-01" })).toEqual({ kind: "not_open", opensOn: "2027-02-28" })
  })
  it("offers a purchase only with a current valuation", () => {
    expect(endOfTermOffer({ ...base, today: "2027-09-01" })).toEqual({ kind: "open", options: ["RETURN", "EXTEND", "PURCHASE"] })
    expect(endOfTermOffer({ ...base, today: "2027-09-01", currentValuation: false })).toEqual({ kind: "open", options: ["RETURN", "EXTEND"] })
  })
  it("offers nothing once chosen, and nothing on a closed lease", () => {
    expect(endOfTermOffer({ ...base, today: "2027-09-01", chosen: true })).toEqual({ kind: "chosen" })
    expect(endOfTermOffer({ ...base, today: "2027-09-01", status: "CANCELLED" })).toEqual({ kind: "closed" })
  })
})

describe("canSubmitReading", () => {
  it("needs contracted usage and a running lease", () => {
    expect(canSubmitReading({ status: "ACTIVE", usageUnit: "KM" })).toBe(true)
    expect(canSubmitReading({ status: "DEFAULTED", usageUnit: "HOURS" })).toBe(true)
    expect(canSubmitReading({ status: "ACTIVE", usageUnit: null })).toBe(false)
    expect(canSubmitReading({ status: "COMPLETED", usageUnit: "KM" })).toBe(false)
  })
})
