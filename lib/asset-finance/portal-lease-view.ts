// What the portal offers a lessee, decided from facts the loader read. Pure:
// the page, the components and the tests share these answers, and every action
// they offer is re-checked by its route (app/api/portal/asset-finance/leases).
import { addMonthsClamped } from "./dates"
import { ELECTION_WINDOW_MONTHS } from "./lease-end-of-term"

export type PortalRentalState = "PAID" | "PARTIAL" | "OVERDUE" | "PENDING" | "CANCELLED"

/** Where one rental stands: a cancelled rental (early termination) is owed nothing. */
export function rentalState(row: { cancelled: boolean; totalCents: number; paidCents: number; dueDate: string }, today: string): PortalRentalState {
  if (row.cancelled) return "CANCELLED"
  if (row.paidCents >= row.totalCents) return "PAID"
  if (row.dueDate < today) return "OVERDUE"
  return row.paidCents > 0 ? "PARTIAL" : "PENDING"
}

/** What a rental still owes: nothing once cancelled or paid. */
export function rentalOutstanding(row: { cancelled: boolean; totalCents: number; paidCents: number }): number {
  return row.cancelled ? 0 : Math.max(0, row.totalCents - row.paidCents)
}

/** A running lease: the states in which a lessee may report a reading or ask for a quote. */
export function leaseRunning(status: string): boolean {
  return status === "ACTIVE" || status === "DEFAULTED"
}

/** A meter reading is asked for only on a running lease that has contracted usage. */
export function canSubmitReading(input: { status: string; usageUnit: string | null }): boolean {
  return input.usageUnit !== null && leaseRunning(input.status)
}

export type QuoteState = "NONE" | "VALID" | "EXPIRED" | "ACCEPTED"

export interface QuoteFacts {
  status: "QUOTED" | "ACCEPTED"
  validUntil: string
}

export function quoteState(quote: QuoteFacts | null, today: string): QuoteState {
  if (!quote) return "NONE"
  if (quote.status === "ACCEPTED") return "ACCEPTED"
  return today > quote.validUntil ? "EXPIRED" : "VALID"
}

export interface TerminationActions {
  state: QuoteState
  /** A (new) quote may be asked for. */
  canRequest: boolean
  /** The latest quote may be accepted, within its validity. */
  canAccept: boolean
}

export function terminationActions(input: {
  status: string
  endOfTermStarted: boolean
  penaltyConfigured: boolean
  quote: QuoteFacts | null
  today: string
}): TerminationActions {
  const state = quoteState(input.quote, input.today)
  const open = leaseRunning(input.status) && !input.endOfTermStarted && state !== "ACCEPTED"
  return { state, canRequest: open && input.penaltyConfigured, canAccept: open && state === "VALID" }
}

export type EndOption = "RETURN" | "EXTEND" | "PURCHASE"

export type EndOfTermOffer =
  | { kind: "closed" }
  | { kind: "chosen" }
  | { kind: "not_open"; opensOn: string }
  | { kind: "open"; options: EndOption[] }

/**
 * The end-of-term choice (lib/asset-finance/lease-end-of-term.ts electEndOfTerm):
 * offered from ELECTION_WINDOW_MONTHS before the last rental, once. A purchase
 * is offered only with a current valuation of the asset to price it on.
 */
export function endOfTermOffer(input: { status: string; lastRentalDate: string; chosen: boolean; currentValuation: boolean; today: string }): EndOfTermOffer {
  if (input.chosen) return { kind: "chosen" }
  if (input.status !== "ACTIVE" && input.status !== "COMPLETED" && input.status !== "DEFAULTED") return { kind: "closed" }
  const opensOn = addMonthsClamped(input.lastRentalDate, -ELECTION_WINDOW_MONTHS)
  if (input.today < opensOn) return { kind: "not_open", opensOn }
  return { kind: "open", options: input.currentValuation ? ["RETURN", "EXTEND", "PURCHASE"] : ["RETURN", "EXTEND"] }
}
