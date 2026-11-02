import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Variable-rate loans whose reference moved (lib/product-engine/reprice-batch.ts): after the night's version activation.
  // Idempotent per loan and effective date and sends nothing, so every replica runs it; a missed night is made up the next.
  { route: "loan-rate-reprice", owner: "in-process", schedule: "25 0 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
