import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Outbound lender webhooks (lib/lender-api/webhooks/dispatch.ts): fans out
  // new outbox events and POSTs due deliveries with retry backoff. Every
  // minute; idle for tenants without an active endpoint.
  { route: "webhook-deliveries", owner: "in-process", schedule: "* * * * *", freshnessMinutes: 10 },
  // Lender API retention (lib/lender-api/retention.ts): prunes old API
  // request logs and finished webhook deliveries. Nightly, off-peak.
  { route: "lender-api-retention", owner: "in-process", schedule: "15 3 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
