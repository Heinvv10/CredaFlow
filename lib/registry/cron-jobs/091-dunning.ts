import { DAY, HOUR, defineCronJobs } from "../define"

// The nightly dunning chain, in the order its data flows. Each job sweeps every
// ACTIVE tenant. escalations and reminders send borrower comms, so they run on
// one replica a day (singleRun), are fired again 30 and 60 minutes later (a later
// firing runs only over a FAILED or dead run, lib/ops/cron-run-claim.ts), and never
// before 07:00 SAST. dpd-update sends nothing and is idempotent, so every replica
// may run it; escalations and reminders make sure it is done for their tenant first
// (lib/loan/dpd-update.ts).
//
//   01:30 default-charges  accrue the completed day's default interest
//   02:00 dpd-update       recompute DPD + arrears (what the next two read)
//   06:00 arrangement-check settle kept/broken arrangements (the dunning holds)
//   07:00 escalations      advance the DPD stages, incl. the 60-DPD DEFAULTED notice
//                          (retried 07:30, 08:00)
//   07:30 reminders        pre/post-due reminders (retried 08:00, 08:30)
//
// Reminders must see the DEFAULTED flips escalations makes, and escalations' retries
// overlap reminders' own times, so the order is not left to the clock: reminders
// declare `after: "escalations"` and wait until it is DONE, or FAILED on its last
// firing (so a tenant that always fails cannot hold every lender back). If
// escalations is still running at 08:30 reminders do not run that day, and
// /api/health shows them stale.
//
// The routes stay callable with the cron secret for a manual ops run. An external
// timer calling them as well would fire them twice: the single-run claim covers
// only this scheduler (docs/DEPLOY.md, "Scheduling").
export default defineCronJobs([
  { route: "dpd-update", owner: "in-process", schedule: "0 2 * * *", freshnessMinutes: DAY + 2 * HOUR },
  { route: "escalations", owner: "in-process", schedule: "0 7 * * *", freshnessMinutes: DAY + 2 * HOUR, singleRun: true },
  { route: "reminders", owner: "in-process", schedule: "30 7 * * *", freshnessMinutes: DAY + 2 * HOUR, singleRun: true, after: "escalations" },
] as const)
