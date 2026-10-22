import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Erases the dealer-captured people, business and documents of dealer deals
  // past their retention (lib/dealer/draft-purge.ts, POPIA s14): drafts the
  // lender never received after 90 days, ended handed-over deals after three
  // years. Keeps a tombstone. Idempotent. Sends nothing.
  { route: "asset-finance-dealer-draft-purge", owner: "in-process", schedule: "50 3 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
