import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Pseudonymises a lender's aged credit decision records, once it has set a
  // retention period (lib/learning-loop/retention/job.ts). Does nothing for a
  // lender with no period. After decision-outcomes (00:30) by time. Idempotent;
  // sends nothing, so every replica runs it.
  { route: "decision-record-retention", owner: "in-process", schedule: "15 1 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
