import { DAY, HOUR, defineCronJobs } from "../define"

// The nightly dunning chain, in the order its data flows, once a SAST day on one
// replica (singleRun). Each job sweeps every ACTIVE tenant.
//
//   01:30 default-charges  accrue the completed day's default interest
//   02:00 dpd-update       recompute DPD + arrears (what the next two read)
//   02:30 escalations      advance the DPD stages, incl. the 60-DPD DEFAULTED notice
//   06:00 arrangement-check settle kept/broken arrangements (the dunning holds)
//   07:00 reminders        pre/post-due reminders, after the holds are current
//
// The gaps leave a run room to finish before the next starts. The routes stay
// callable with the cron secret for a manual ops run. An external timer calling
// them as well would fire them twice: the single-run claim covers only this
// scheduler (docs/DEPLOY.md, "Scheduling").
export default defineCronJobs([
  { route: "dpd-update", owner: "in-process", schedule: "0 2 * * *", freshnessMinutes: DAY + 2 * HOUR, singleRun: true },
  { route: "escalations", owner: "in-process", schedule: "30 2 * * *", freshnessMinutes: DAY + 2 * HOUR, singleRun: true },
  { route: "reminders", owner: "in-process", schedule: "0 7 * * *", freshnessMinutes: DAY + 2 * HOUR, singleRun: true },
] as const)
