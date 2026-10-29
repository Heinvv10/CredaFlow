import { HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Every 10 minutes — purges expired RateLimitHit rows (lib/rate-limit-store.ts). A key's row
  // outlives its window by at most one pass. Idempotent, sends nothing, so every replica runs it.
  { route: "rate-limit-cleanup", owner: "in-process", schedule: "*/10 * * * *", freshnessMinutes: 2 * HOUR },
] as const)
