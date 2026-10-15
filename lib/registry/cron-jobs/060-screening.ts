import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // PEP / sanctions re-screen of active clients whose latest run is older
  // than SCREENING_MAX_AGE_DAYS (lib/screening/refresh.ts). Idle for tenants
  // without TenantConfig.screeningProvider. Nightly, outside business hours,
  // because each client is a provider call.
  { route: "screening-refresh", owner: "in-process", schedule: "15 2 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
