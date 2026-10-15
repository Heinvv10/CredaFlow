import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Default interest and post-default charges (lib/loan/charges-sweep.ts).
  // Idle unless TenantConfig.defaultChargesEnabled is on for a tenant.
  // Nightly, after SAST midnight, so the completed day has accrued.
  { route: "default-charges", owner: "in-process", schedule: "30 1 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
