import { defineCronJobs } from "../define"

// OWNERSHIP RULE: the deployment's external scheduler must invoke these (e.g.
// timers that call the route with the cron secret). Nothing in this repository
// schedules them, so this list is a written claim about the deployment, not
// something a test can verify: confirm it against the deployment's scheduler.
//
// Never schedule them in-process as well: with an external scheduler in place
// they would fire twice nightly, which risks duplicate NCA-mandated borrower
// comms (Section 129 notices, payment reminders).
export default defineCronJobs([
  { route: "cleanup-notifications", owner: "external" },
  { route: "dpd-update", owner: "external" },
  { route: "email-poll", owner: "external" },
  { route: "escalations", owner: "external" },
  { route: "lead-task-reminders", owner: "external" },
  { route: "messaging-retry", owner: "external" },
  { route: "reminders", owner: "external" },
] as const)
