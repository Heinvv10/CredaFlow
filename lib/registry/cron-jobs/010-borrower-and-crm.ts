import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Nightly at 07:00 — send payment reminder emails (3-day-before).
  // It duplicates the externally scheduled `reminders` endpoint, but it IS
  // scheduled in-process and runs nightly; never declare it unwired.
  { route: "payment-reminders", owner: "in-process", schedule: "0 7 * * *", freshnessMinutes: DAY + 2 * HOUR },
  // Nightly at 06:00 — insurance renewal reminders (30-day warning)
  { route: "insurance-renewal", owner: "in-process", schedule: "0 6 * * *", method: "POST", freshnessMinutes: DAY + 2 * HOUR },
  // Weekly Sunday at 03:00 — cross-sell opportunity evaluation
  { route: "cross-sell", owner: "in-process", schedule: "0 3 * * 0", method: "POST", freshnessMinutes: 7 * DAY + 2 * HOUR },
  // Weekly Sunday at 04:00 — flag dormant clients for re-engagement
  { route: "dormant-clients", owner: "in-process", schedule: "0 4 * * 0", method: "POST", freshnessMinutes: 7 * DAY + 2 * HOUR },
  // Daily at 08:30 — alert agents with stale leads (48h+ no activity)
  { route: "stale-leads-alert", owner: "in-process", schedule: "30 8 * * *", freshnessMinutes: DAY + 2 * HOUR },
  // Daily at 06:00 — evaluate all active payment arrangements (kept/broken/completed)
  { route: "arrangement-check", owner: "in-process", schedule: "0 6 * * *", freshnessMinutes: DAY + 2 * HOUR },
  // Daily at 05:15 SAST — FAIS Fit & Proper adviser licence expiry (60-day
  // warning). Scheduled in-process rather than externally because no external
  // timer owns it, so there is nothing for an in-process schedule to
  // double-fire against. Regression pin in instrumentation.cron-census.test.ts:
  // the route once existed and nothing ever called it.
  { route: "licence-expiry", owner: "in-process", schedule: "15 5 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
