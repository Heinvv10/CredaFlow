import { HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // A tracker on a completed loan (lib/asset-finance/tracker-closure.ts): the borrower's
  // portal notice, the email (sendMessage, consent and kill switches as ever)
  // and the stored "tracking stopped" letter, each once. Idempotent.
  { route: "asset-finance-telematics-closure", owner: "in-process", schedule: "*/15 * * * *", freshnessMinutes: HOUR },
] as const)
