import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Decision outcomes from the servicing tables (lib/learning-loop/outcomes/job.ts).
  // After arrears-snapshot (23:45) by time: `after` needs a singleRun target and
  // that job is not one. Sends nothing and is idempotent, so every replica runs it.
  { route: "decision-outcomes", owner: "in-process", schedule: "30 0 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
