import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Asset-finance recoveries whose post-sale charge freeze ended: move the
  // shortfall loan on to collections and ring the bell
  // (lib/asset-finance/recovery-freeze-deadline.ts). Never writes off. Idempotent.
  { route: "asset-finance-recovery-deadlines", owner: "in-process", schedule: "20 2 * * *", freshnessMinutes: DAY + 2 * HOUR },
] as const)
