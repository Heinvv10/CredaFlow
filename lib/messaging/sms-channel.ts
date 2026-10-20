/**
 * The single source of truth for "is the SMS channel usable right now".
 *
 * A deployment may run `BULKSMS_DRY_RUN=true` (or leave it unset) - a supported operating mode (see
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
 * FAILS CLOSED: SMS is off by policy (lib/messaging/.claude.md), so the channel
 * is on ONLY when `BULKSMS_DRY_RUN` is exactly "false" - an explicit opt-in.
 * Unset, empty and every other value (including "true") are off. It used to be
 * `!== "true"`, which meant a deployment that never set the variable
 * (provision-lender.sh does not) silently had live SMS.
 */
export function isSmsChannelEnabled(): boolean {
  return process.env.BULKSMS_DRY_RUN === "false"
}

/** Wording for the blocked/skipped accounting when the channel is off. */
export const SMS_CHANNEL_OFF_REASON = "SMS not enabled"
