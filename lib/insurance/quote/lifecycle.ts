// What a quote is allowed to become, and from where.
//
// PURE: no Prisma, no I/O, no `new Date()`. The caller loads the quote and
// supplies the facts; this decides. That keeps the transition table assertable
// without a database, which matters because it is the only thing standing
// between a staff member and a quote that skips its own record of advice.
//
// THREE PROPERTIES THIS FILE EXISTS TO HOLD:
//
//   1. TRANSITIONS ARE ONE-DIRECTIONAL. A quote never moves back up the chain.
//      There is no path out of REJECTED, CONVERTED or EXPIRED — they are
//      terminal — and no path from ACCEPTED back to DRAFT. Re-pricing is a NEW
//      quote, the same discipline rate table versions follow: the price a
//      client was shown must stay reconstructable, and mutating a quote back
//      into DRAFT to re-rate it destroys exactly that evidence.
//
//   2. CONVERTED IS SET ONLY BY THE BIND. It is the one status that means a
//      policy exists, so it may not be reachable through a general-purpose
//      status endpoint — that would let a caller mark a quote converted with no
//      policy behind it, and `convertedPolicyId` would stay null while the
//      status claimed otherwise. `canTransition` refuses it unless the caller
//      declares `via: "BIND"`, and only the bind path is entitled to say so.
//
//   3. ADVICE IS A PRECONDITION, NOT A FORMALITY. FAIS requires a record of
//      advice from an intermediary that gives advice. A quote may not reach
//      ADVICE_RECORDED or anything after it without one, so the check is on
//      the TARGET status rather than on the endpoint that happens to be called
//      — an endpoint-side check is one a second endpoint forgets.

import type { QuoteStatus } from "@prisma/client"

/**
 * Every status a quote may move to next.
 *
 * `Record<QuoteStatus, …>` rather than a lookup with a default, so adding a
 * status to the schema fails the type check here instead of silently becoming
 * a status nothing can enter and nothing can leave.
 */
const ALLOWED_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  DRAFT: ["QUOTED", "REJECTED", "EXPIRED"],
  QUOTED: ["ADVICE_RECORDED", "REJECTED", "EXPIRED"],
  ADVICE_RECORDED: ["SUBMITTED_TO_INSURER", "REJECTED", "EXPIRED"],
  SUBMITTED_TO_INSURER: ["ACCEPTED", "REJECTED", "EXPIRED"],
  ACCEPTED: ["CONVERTED", "EXPIRED"],
  // Terminal. A rejected or expired quote is history; a converted one has a
  // policy behind it and the policy's own lifecycle takes over from here.
  REJECTED: [],
  CONVERTED: [],
  EXPIRED: [],
}

/** Statuses from which nothing may follow. Derived, so it cannot drift. */
export const TERMINAL_STATUSES: readonly QuoteStatus[] = (
  Object.keys(ALLOWED_TRANSITIONS) as QuoteStatus[]
).filter((status) => ALLOWED_TRANSITIONS[status].length === 0)

/**
 * Statuses that may not be entered without a persisted `InsuranceAdviceRecord`.
 *
 * ADVICE_RECORDED is in the set because that status IS the claim that advice
 * was recorded; the three after it are in the set because a quote that reached
 * them without advice would have skipped the obligation rather than satisfied
 * it late.
 */
export const STATUSES_REQUIRING_ADVICE: readonly QuoteStatus[] = [
  "ADVICE_RECORDED",
  "SUBMITTED_TO_INSURER",
  "ACCEPTED",
  "CONVERTED",
]

/** Statuses only the bind path may set. See property 2 above. */
export const BIND_ONLY_STATUSES: readonly QuoteStatus[] = ["CONVERTED"]

export type TransitionRefusal =
  | "SAME_STATUS"
  | "TERMINAL_STATUS"
  | "NOT_ALLOWED"
  | "BIND_ONLY"
  | "ADVICE_REQUIRED"
  | "NOT_SELLABLE"

export interface TransitionFacts {
  /** Whether an `InsuranceAdviceRecord` exists for this quote. */
  hasAdviceRecord: boolean
  /**
   * The quote's PERSISTED `eligibilityResult.pass`, read from the row.
   *
   * Defaults to FALSE. A caller that does not supply it cannot promote a DRAFT,
   * which is the fail-closed direction: forgetting to pass the evidence must
   * not read as the evidence being favourable.
   */
  eligibilityPassed?: boolean
  /**
   * Whether the quote carries a `totalPremium`. Also defaults to FALSE.
   *
   * Without it a quote could be promoted to QUOTED with a null premium and then
   * take a statutory FAIS Record of Advice whose content hash covers
   * `totalPremium: null` — a signed record of advice about no price at all.
   */
  hasPrice?: boolean
  /**
   * How the transition is being attempted. "BIND" is the policy bind running
   * inside the transaction that creates the policy; "API" is a staff member
   * driving the status endpoint. Defaults to "API" — the constrained one — so
   * a caller that forgets to say gets the narrower permission, not the wider.
   */
  via?: "API" | "BIND"
}

export type TransitionResult =
  | { ok: true }
  | { ok: false; reason: TransitionRefusal; detail: string }

/**
 * May this quote move from `from` to `to`?
 *
 * Total: every refusal is a returned reason, never a throw, so a route can turn
 * it into a 409 with the reason named rather than a 500 with nothing in it.
 */
export function canTransition(
  from: QuoteStatus,
  to: QuoteStatus,
  facts: TransitionFacts,
): TransitionResult {
  if (from === to) {
    return { ok: false, reason: "SAME_STATUS", detail: `The quote is already ${from}` }
  }

  if (TERMINAL_STATUSES.includes(from)) {
    return {
      ok: false,
      reason: "TERMINAL_STATUS",
      detail: `${from} is terminal — a change of mind is a new quote, not an edit to this one`,
    }
  }

  // Checked before the transition table so the refusal names the real reason: a
  // staff member posting CONVERTED to the status endpoint from ACCEPTED is
  // making an allowed-on-paper move for a disallowed reason, and telling them
  // "not allowed from ACCEPTED" would be a lie they cannot act on.
  if (BIND_ONLY_STATUSES.includes(to) && facts.via !== "BIND") {
    return {
      ok: false,
      reason: "BIND_ONLY",
      detail: `${to} is set only by binding the quote to a policy, in the transaction that creates it`,
    }
  }

  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      reason: "NOT_ALLOWED",
      detail: `A quote cannot move from ${from} to ${to}`,
    }
  }

  // Leaving DRAFT for QUOTED is the laundering path, and it is checked against
  // the quote's OWN PERSISTED EVIDENCE rather than against the caller's word.
  //
  // `createQuote` refuses to WRITE a QUOTED row for a quote that failed rating
  // or screening — that is well tested. It is also not enough: the invariant
  // guarded the WRITER, not the STATE, so a later PATCH could set the status
  // the writer had refused. A quote whose lives the insurer's captured terms
  // reject could then be advised on, accepted and bound into an ACTIVE policy,
  // by the same role, with no escalation.
  //
  // Note what this means today: nothing can flip a persisted quote's
  // `eligibilityResult` or give it a premium after the fact — there is no
  // re-rate endpoint — so a DRAFT can never satisfy this and the transition is
  // unreachable in practice. It is kept rather than deleted because the check
  // belongs on the STATE regardless of which endpoints happen to exist, and a
  // future re-rate path would make it live without needing to rediscover why.
  if (from === "DRAFT" && to === "QUOTED") {
    if (!facts.eligibilityPassed || !facts.hasPrice) {
      return {
        ok: false,
        reason: "NOT_SELLABLE",
        detail:
          "This quote was drafted because it could not be priced or failed the insurer's acceptance terms. Re-quote rather than promoting it.",
      }
    }
  }

  if (STATUSES_REQUIRING_ADVICE.includes(to) && !facts.hasAdviceRecord) {
    return {
      ok: false,
      reason: "ADVICE_REQUIRED",
      detail: `${to} requires a FAIS record of advice for this quote`,
    }
  }

  return { ok: true }
}

/** The statuses a quote in `from` may currently move to, given the same facts. */
export function nextStatuses(from: QuoteStatus, facts: TransitionFacts): QuoteStatus[] {
  return ALLOWED_TRANSITIONS[from].filter((to) => canTransition(from, to, facts).ok)
}
