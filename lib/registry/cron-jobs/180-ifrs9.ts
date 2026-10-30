import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // IFRS 9 month-end staging run (lib/ifrs9/run.ts): fires every night, writes only on the last SAST day of
  // the month, at the end of it so the position is the month's. Idempotent (one MONTHLY run per tenant per
  // month; a second replica gets the first one's run) and sends nothing, so every replica runs it.
  { route: "ifrs9-run", owner: "in-process", schedule: "50 23 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
