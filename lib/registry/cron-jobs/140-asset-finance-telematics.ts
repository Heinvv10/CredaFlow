import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Tracker/telematics (lib/telematics/poll.ts): polls every ACTIVE device of
  // each asset-finance tenant through its provider; idempotent per provider
  // event id. Sends nothing.
  { route: "asset-finance-telematics-poll", owner: "in-process", schedule: "*/15 * * * *", freshnessMinutes: HOUR },
  // Deletes tracker positions (and heartbeat, ignition and position events)
  // past each tenant's retention (lib/telematics/purge.ts). Idempotent.
  { route: "asset-finance-telematics-purge", owner: "in-process", schedule: "40 3 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
