/**
 * The window in which money must ARRIVE for a promise-to-pay to count as kept,
 * and the threshold that decides it.
 *
 * Shared because there are two implementations of this rule — the read-only
 * `getPromiseToPayStatus` (which filters in Prisma) and `PromiseToPayTab`
 * (which filters in JS over already-loaded payments). They had drifted: the
 * component required `promiseAmount > 0`, the lib did not, so a malformed
 * zero-amount promise read as KEPT there and BROKEN here. Keep the rule in one
 * place or they will disagree again.
 */

/** Days after the promised date that money may still arrive. */
export const PROMISE_GRACE_DAYS = 3

/** Share of the promised amount that counts as honouring it. */
export const PROMISE_KEPT_FRACTION = 0.9

/**
 * Bounds are on the date money ARRIVED, never the date staff captured it: a
 * promise honoured on the day but captured after the grace period is kept, and
 * marking it broken feeds collections escalation and, downstream, s129.
 *
 * The lower bound is the note's own creation — the moment the promise was made.
 */
export function promiseWindow(args: {
  noteCreatedAt: Date
  promiseDate: Date
}): { start: Date; end: Date } {
  const end = new Date(args.promiseDate)
  // setDate preserves time-of-day, so this is stable across zones. SA has no
  // DST, so no window silently gains or loses an hour.
  end.setDate(end.getDate() + PROMISE_GRACE_DAYS)
  return { start: new Date(args.noteCreatedAt), end }
}

export function isPromiseKept(args: {
  promiseAmount: number
  totalReceived: number
}): boolean {
  // A promise of nothing is not a promise kept — it is an unparseable note.
  if (args.promiseAmount <= 0) return false
  return args.totalReceived >= args.promiseAmount * PROMISE_KEPT_FRACTION
}
