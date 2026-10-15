import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // DebiCheck collections engine (lib/collections-engine). Idle for every
  // tenant without TenantConfig.collectionsEngineEnabled (the run reads only
  // the enabled-tenant list). Results first, so a re-presentment is planned
  // from the latest unpaid; submit after, early enough for the two-business-
  // day lead to land on the day's earliest action date.
  { route: "collections-results", owner: "in-process", schedule: "15 6 * * *", freshnessMinutes: DAY + 2 * HOUR },
  { route: "collections-submit", owner: "in-process", schedule: "45 6 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
