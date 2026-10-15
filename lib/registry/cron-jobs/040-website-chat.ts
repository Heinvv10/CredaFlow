import { HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Closes website chats idle for 24h unless handed off to staff
  // (lib/website-chat/auto-close.ts). Hourly, so a chat closes within an
  // hour of reaching the limit.
  { route: "website-chat-close", owner: "in-process", schedule: "20 * * * *", freshnessMinutes: 3 * HOUR },
  // Times out website-chat hand-offs nobody joined and emails staff about
  // them (lib/website-chat/handoff-sweep.ts). Every minute: the visitor is
  // told within two minutes, so the email must not lag far behind.
  { route: "website-chat-handoffs", owner: "in-process", schedule: "* * * * *", freshnessMinutes: 10 },
] as const)
