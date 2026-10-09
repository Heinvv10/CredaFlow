// Who may receive lead outreach. Prisma-free on purpose: the lead detail page
// renders the reason in a client component, and the send path enforces the
// same predicate server-side. One rule, two callers, no drift.

// Type-only import — erased at compile time, so this module stays free of any
// runtime import (the client-side picker imports it).
import type { LeadStatus } from "@prisma/client"

export type LeadOutreachIneligibility = "NOT_A_LOAN_ENQUIRY" | "LEAD_CLOSED"

/**
 * The ONLY statuses that may receive outreach — an allow-list, not a
 * deny-list, so the gate fails closed when the enum grows.
 *
 * A deny-list of {CONVERTED, LOST} would silently enrol every future status:
 * the day someone adds ARCHIVED / DO_NOT_CONTACT / DECEASED, those leads
 * would start receiving "your loan application is still open". Typing the
 * key as LeadStatus also makes the compiler point here when the enum changes,
 * rather than letting it pass unnoticed.
 */
const OUTREACHABLE_STATUSES: Record<LeadStatus, boolean> = {
  NEW: true,
  CONTACTED: true,
  QUALIFIED: true,
  PROPOSAL_SENT: true,
  // The copy says "your loan application is still open" — false for both.
  CONVERTED: false,
  LOST: false,
}

export type LeadOutreachEligibility =
  | { ok: true }
  | { ok: false; reason: LeadOutreachIneligibility; detail: string }

/**
 * Whether this lead may lawfully receive outreach, and why not if not.
 *
 * The SERVICE classification these templates carry (lead-outreach-templates.ts)
 * rests entirely on a claim about the RECIPIENT — that they asked us for a
 * loan. Nothing else in the stack checks it: `Lead` has no relation to any
 * application model, and the eligibility engine's Lane 5 clears any SERVICE
 * template regardless of who it is going to. So this predicate is the only
 * thing between the copy and an unsolicited credit approach — which, to
 * someone who never enquired, is POPIA s.69 direct marketing they hold no
 * consent for (nothing in this codebase grants MARKETING_GENERAL, and a lead
 * is not a CLIENT so the s.69(3)(a) soft-opt-in lane cannot fire either).
 *
 * `requestedAmount` is the discriminator because it is a recorded fact rather
 * than an inference. The path that represents a real credit application sets
 * it — `app/api/website/apply`. The website contact form
 * (`app/api/website/contact`, `tags:["contact-form"]` — a general enquiry)
 * omits it. Staff-created leads carry one only when staff recorded an amount.
 *
 * Fails closed on BOTH axes: an unrecognised status is refused (allow-list),
 * and a borrower whose amount was never captured gets no outreach until it is.
 */
export function leadOutreachEligibility(lead: {
  status: string
  requestedAmount: number | bigint | null
}): LeadOutreachEligibility {
  // Status first: for a closed lead the copy ("your loan application is still
  // open") is false regardless of how the lead arrived. Unknown values fall
  // here too — `Record<LeadStatus, boolean>` lookup on an arbitrary string
  // yields undefined, which is not true, so it is refused.
  if (!OUTREACHABLE_STATUSES[lead.status as LeadStatus]) {
    return {
      ok: false,
      reason: "LEAD_CLOSED",
      detail: "This lead's status means its application is not open — nothing to follow up on.",
    }
  }
  // `!(x > 0)`, not `x === null || x <= 0`: the contract this predicate claims
  // to enforce is "a recorded fact that this person asked us for CREDIT", and
  // R0 or a negative is not that. Written as a negated positive so it refuses
  // null, undefined AND NaN in one expression — `<= 0` is false for NaN, so
  // the naive form failed OPEN on a field that arrived undefined. Unreachable
  // today (sendLeadOutreach always selects it) but this is the last line of
  // defence, and the whole point of the status axis above is that it fails
  // closed; this axis should too.
  if (!(Number(lead.requestedAmount) > 0)) {
    return {
      ok: false,
      reason: "NOT_A_LOAN_ENQUIRY",
      detail:
        "No requested amount on file, so there is no loan enquiry to service. " +
        "Capture the amount they asked for first.",
    }
  }
  return { ok: true }
}
