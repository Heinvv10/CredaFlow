import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Walks every AuditLog hash chain and records the result as an audit row; a
  // break is also a 500 here and an AUDIT_CHAIN_BROKEN row (lib/audit/verify-job.ts).
  // Read-only apart from that row, so one replica a day is enough.
  { route: "audit-chain-verify", owner: "in-process", schedule: "30 2 * * *", singleRun: true, freshnessMinutes: DAY + 2 * HOUR },
  // Ships the SIEM outbox (lib/audit/siem/deliver.ts). Every replica may run it:
  // batches are claimed with SKIP LOCKED.
  { route: "audit-siem-deliver", owner: "in-process", schedule: "*/2 * * * *", freshnessMinutes: 30 },
] as const)
