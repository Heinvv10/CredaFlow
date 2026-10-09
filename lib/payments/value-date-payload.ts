/**
 * The value-date half of a manual capture payload.
 *
 * Split out of the form so the rules that decide WHICH dates and reasons reach
 * /api/payments are testable without rendering: they are the difference between
 * billing a client for a capture delay and not.
 */
export interface ValueDatePayload {
  receivedAt?: string
  valueDateOverrideReason?: string
}

/**
 * What the capture form must put in front of staff for the chosen date.
 *
 * A predicate rather than JSX so the rule is testable: a static render can
 * never set a date, so a conditional written inline in the component is
 * permanently false and any test of it passes vacuously.
 */
export type ValueDatePrompt =
  /** Same-day (or blank) — nothing to authorise, nothing to warn about. */
  | "none"
  /** Back-dated, and this user may record the authorisation themselves. */
  | "override_reason"
  /** Back-dated, but authorising it is above this user's role. */
  | "authorisation_warning"

export function valueDatePrompt(args: {
  receivedAt: string
  canAuthoriseBackdate: boolean
  today: string
}): ValueDatePrompt {
  if (!isBackdated(args.receivedAt, args.today)) return "none"
  return args.canAuthoriseBackdate ? "override_reason" : "authorisation_warning"
}

/** Blank means today, so it is never back-dated. */
function isBackdated(receivedAt: string, today: string): boolean {
  return receivedAt !== "" && receivedAt < today
}

export function valueDatePayload(args: {
  /** YYYY-MM-DD in SAST, or "" for "the money arrived today" */
  receivedAt: string
  overrideReason: string
  /** Cosmetic role affordance — the API re-checks and 403s regardless. */
  canAuthoriseBackdate: boolean
  /** Today's SAST calendar day, YYYY-MM-DD */
  today: string
}): ValueDatePayload {
  const payload: ValueDatePayload = {}

  // Absent means "today" to the API. Sending "" instead would fail its date
  // parse and reject an otherwise ordinary capture.
  if (!args.receivedAt) return payload
  payload.receivedAt = args.receivedAt

  // A reason only means anything on a back-date. Attaching one to a same-day
  // capture would record an authorisation for an exception that never happened
  // — including one the user typed, then retracted by changing the date back.
  const reason = args.overrideReason.trim()
  if (
    valueDatePrompt({
      receivedAt: args.receivedAt,
      canAuthoriseBackdate: args.canAuthoriseBackdate,
      today: args.today,
    }) === "override_reason"
    && reason
  ) {
    payload.valueDateOverrideReason = reason
  }
  return payload
}
