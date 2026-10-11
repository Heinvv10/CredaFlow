/**
 * The single source of truth for "is the SMS channel usable right now".
 *
 * A deployment may run `BULKSMS_DRY_RUN=true` — a supported operating mode (see
 * lib/integrations/simulation-guard.ts): nothing is fabricated, sends land as
 * status `SIMULATED`. But a simulated send is not a send, so every dispatch
 * path must skip its SMS leg rather than write a `SIMULATED` Message row and a
 * LoanNote that reads as if the borrower was contacted.
 *
 * Deliberately NOT the same condition as `isDryRun()` in
 * lib/integrations/bulksms.ts, which ALSO treats `NODE_ENV=test` as dry-run.
 * That arm exists to keep the unit suite off the wire; folding it in here would
 * switch the channel off for every test and make the guards untestable in the
 * "channel on" direction.
 *
 * Strict `=== "true"` matches getChannelAvailability's original inline test, so
 * the composer UI and the background senders cannot disagree about whether the
 * channel is on.
 */
export function isSmsChannelEnabled(): boolean {
  return process.env.BULKSMS_DRY_RUN !== "true"
}

/** Wording for the blocked/skipped accounting when the channel is off. */
export const SMS_CHANNEL_OFF_REASON = "SMS not enabled"
