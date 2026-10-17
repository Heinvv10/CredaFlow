import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Daily per-loan arrears history for the NCR return (lib/reports/arrears-snapshot.ts).
  // Late in the SAST day, so each row describes the date it carries. Idempotent per day.
  { route: "arrears-snapshot", owner: "in-process", schedule: "45 23 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
