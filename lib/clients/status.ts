// The four client statuses the signed Annexure names, and the credit gate that
// follows from them.
//
// Prisma-free on purpose: the client wizard renders the status badge in a
// client component and the API routes enforce the same predicate server-side.
// One rule, two callers, no drift — the same shape as
// lib/crm/lead-outreach-eligibility.ts.

// Type-only import — erased at compile time, so this module stays free of any
// runtime import and can be pulled into a "use client" bundle.
import type { LoanStatus } from "@prisma/client"

export type ClientStatus = "ACTIVE" | "BLACKLISTED" | "DECEASED" | "PAID_UP"

export interface ClientStatusInput {
  /** Set when a death has been recorded. Asserted fact, never derived. */
  deceasedAt: Date | null
  /** Asserted fact, unchanged from the boolean the credit gates already use. */
  blacklisted: boolean
  loans: { status: LoanStatus }[]
}

/**
 * What a loan says about its borrower for the purposes of PAID_UP.
 *
 *   "open"    — unfinished business. The client cannot be paid up.
 *   "settled" — repaid in full.
 *   "ignored" — never ran, so it says nothing either way.
 *
 * Typing this as Record<LoanStatus, …> is load-bearing. Adding a value to
 * LoanStatus becomes a COMPILE ERROR here rather than silently falling into
 * whichever branch the last `else` happens to be — and the cost of that silence
 * is a client wrongly labelled as having settled their debt.
 */
const LOAN_MEANING: Record<LoanStatus, "open" | "settled" | "ignored"> = {
  ACTIVE: "open",
  COMPLETED: "settled",
  // Everything below is the reason this table exists. "No ACTIVE loan" is the
  // obvious test for PAID_UP and it is wrong: it would stamp a defaulter, and
  // someone whose debt we wrote off at a loss, as settled on their own client
  // record. A write-off is the bank taking the loss — the opposite of payment.
  DEFAULTED: "open",
  PENDING_WRITE_OFF: "open",
  WRITTEN_OFF: "open",
  RESTRUCTURED: "open",
  // A cancelled loan never ran. It is neither settlement nor exposure, so it
  // must not make a client PAID_UP on its own, nor hold one out of it.
  CANCELLED: "ignored",
}

/**
 * The client's status, computed rather than stored.
 *
 * Asserted facts outrank derived ones, and DECEASED outranks BLACKLISTED:
 * death is the more absolute fact and the one staff must not miss behind a
 * credit decision.
 *
 * Deriving ACTIVE/PAID_UP from the loans means they cannot go stale — a client
 * becomes paid up the moment their last loan completes, with nothing to keep in
 * sync and no backfill to run.
 */
export function clientStatus(input: ClientStatusInput): ClientStatus {
  if (input.deceasedAt) return "DECEASED"
  if (input.blacklisted) return "BLACKLISTED"

  const meanings = input.loans.map((loan) => LOAN_MEANING[loan.status])
  if (meanings.includes("open")) return "ACTIVE"
  if (meanings.includes("settled")) return "PAID_UP"

  // No loans, or nothing but cancelled ones: a client on the books who owes
  // nothing and has settled nothing.
  return "ACTIVE"
}

/**
 * How each status is shown. Record<ClientStatus, …> again, so a new status
 * cannot reach the UI without someone deciding what it looks like — the
 * alternative is a lookup miss rendering an empty badge.
 */
export const CLIENT_STATUS_BADGE: Record<ClientStatus, { label: string; className: string }> = {
  ACTIVE: { label: "ACTIVE", className: "bg-green-100 text-green-800" },
  PAID_UP: { label: "PAID-UP", className: "bg-blue-100 text-blue-800" },
  BLACKLISTED: { label: "BLACKLISTED", className: "bg-red-600 text-white" },
  DECEASED: { label: "DECEASED", className: "bg-gray-700 text-white" },
}

export type CreditBlockReason = "BLACKLISTED" | "DECEASED"

export type CreditBlock =
  | { blocked: false }
  | { blocked: true; reason: CreditBlockReason; auditReason: string }

const NOT_BLOCKED: CreditBlock = { blocked: false }

/**
 * Whether this client may take on new credit, and why not if not.
 *
 * The audit reasons are distinct strings because the trail has to tell an
 * estate apart from a credit decision — "client_blacklisted" was already in
 * use before deceased existed, so it keeps its exact spelling.
 *
 * Note this deliberately says nothing about collections: a blacklisted client
 * can still be dunned today, and recording a death does not change that. That
 * gap is real and tracked separately; widening this predicate to cover it
 * would reach into live money paths.
 */
export function creditBlock(input: Pick<ClientStatusInput, "deceasedAt" | "blacklisted">): CreditBlock {
  if (input.deceasedAt) {
    return { blocked: true, reason: "DECEASED", auditReason: "client_deceased" }
  }
  if (input.blacklisted) {
    return { blocked: true, reason: "BLACKLISTED", auditReason: "client_blacklisted" }
  }
  return NOT_BLOCKED
}
