// Which servicing step the staff lease panel offers, from the state it shows.
// Pure and client-safe. These mirror the guards in lease-end-of-term.ts,
// lease-end-invoice.ts, maintenance-claims.ts and lease-termination-store.ts
// so a button appears only where the step applies; the route and the database
// still refuse everything else, and a refusal is shown inline.
import type { LeaseEndOutcome, LeaseEndStatus, MaintenanceClaimStatus } from "@prisma/client"

/** The loan statuses on which a lease is still being serviced. */
export const RUNNING_LEASE_STATUSES = ["ACTIVE", "DEFAULTED"] as const
const isRunning = (status: string) => (RUNNING_LEASE_STATUSES as readonly string[]).includes(status)

export type EndStep = "extension-notice" | "inspection" | "invoice" | "natis-confirmed"

export interface EndOfTermState {
  outcome: LeaseEndOutcome
  status: LeaseEndStatus
  extensionNoticeOn: string | null
  extensionEndsOn: string | null
  /** A purchased asset with a registration number: the eNaTIS change must be confirmed. */
  natisRequired: boolean
  natisConfirmed: boolean
}

/** The one next step of a started end of term and the permission it needs; null when it is waiting or done. */
export function nextEndStep(eot: EndOfTermState, today: string): { step: EndStep; needs: "manage" | "decide" } | null {
  switch (eot.status) {
    case "ELECTED":
      return (eot.outcome === "PURCHASE" || eot.outcome === "TOTAL_LOSS") ? { step: "invoice", needs: "decide" } : { step: "inspection", needs: "manage" }
    case "EXTENDING":
      if (!eot.extensionNoticeOn) return { step: "extension-notice", needs: "manage" }
      return eot.extensionEndsOn !== null && eot.extensionEndsOn <= today ? { step: "inspection", needs: "manage" } : null
    case "INSPECTED":
      return { step: "invoice", needs: "decide" }
    case "INVOICED":
      return eot.outcome === "PURCHASE" && eot.natisRequired && !eot.natisConfirmed ? { step: "natis-confirmed", needs: "decide" } : null
    default:
      return null
  }
}

/** The end-of-term choice: open in the six months before the last rental (lease-end-of-term.ts), once. */
export function canElect(input: { loanStatus: string; hasEndOfTerm: boolean; windowOpen: boolean; canManage: boolean }): boolean {
  const statusOk = isRunning(input.loanStatus) || input.loanStatus === "COMPLETED"
  return input.canManage && statusOk && !input.hasEndOfTerm && input.windowOpen
}

export interface ClaimState {
  status: MaintenanceClaimStatus
  submittedById: string
  firstApprovedById: string | null
}

export interface ClaimActions {
  approve: boolean
  reject: boolean
  paid: boolean
  /** Why a decider cannot approve: the four-eyes rule. */
  hint: string | null
}

export function claimActions(claim: ClaimState, ctx: { userId: string; canDecide: boolean }): ClaimActions {
  const none: ClaimActions = { approve: false, reject: false, paid: false, hint: null }
  if (!ctx.canDecide) return none
  if (claim.status === "APPROVED") return { ...none, paid: true }
  if (claim.status !== "SUBMITTED") return none
  if (claim.submittedById === ctx.userId) return { ...none, reject: true, hint: "You submitted this claim: someone else approves it." }
  if (claim.firstApprovedById === ctx.userId) return { ...none, reject: true, hint: "You gave the first approval: a second, different approver is needed." }
  return { ...none, approve: true, reject: true }
}

/** A claim needs a running lease inside its term and a fund not yet settled at the end of term. */
export function canSubmitClaim(input: { loanStatus: string; today: string; leaseEndDate: string; fundSettled: boolean; canManage: boolean }): boolean {
  return input.canManage && isRunning(input.loanStatus) && input.today <= input.leaseEndDate && !input.fundSettled
}

/** Staff record readings for as long as the lease is not being invoiced or closed (the inspection records the final one). */
export function canRecordReading(input: { loanStatus: string; unitContracted: boolean; endStatus: LeaseEndStatus | null; canManage: boolean }): boolean {
  const closing = input.endStatus === "INVOICED" || input.endStatus === "COMPLETED"
  return input.canManage && input.unitContracted && input.loanStatus !== "COMPLETED" && !closing
}

export function canRequestQuote(input: { loanStatus: string; hasEndOfTerm: boolean; canManage: boolean }): boolean {
  return input.canManage && isRunning(input.loanStatus) && !input.hasEndOfTerm
}

export function canAcceptQuote(input: { quoteStatus: "QUOTED" | "ACCEPTED"; validUntil: string; today: string; loanStatus: string; hasEndOfTerm: boolean; canDecide: boolean }): boolean {
  return input.canDecide && input.quoteStatus === "QUOTED" && input.validUntil >= input.today && isRunning(input.loanStatus) && !input.hasEndOfTerm
}
