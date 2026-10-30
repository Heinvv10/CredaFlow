import { DAY, HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Links committed AuditLog rows into the hash chain (lib/audit/chainer.ts): every
  // minute, with a pass every 5 s inside it. Not singleRun (that is once a day): every
  // replica may run it, a chain is worked under an advisory lock.
  { route: "audit-chainer", owner: "in-process", schedule: "* * * * *", freshnessMinutes: 10 },
  // Chains one last time, verifies every chain (from its latest checkpoint; in full on
  // Sundays), writes a checkpoint per chain that held and an AUDIT_CHAIN_BROKEN row per
  // chain that did not (lib/audit/verify-job.ts).
  { route: "audit-chain-verify", owner: "in-process", schedule: "30 2 * * *", singleRun: true, freshnessMinutes: DAY + 2 * HOUR },
  // Ships the SIEM outbox in order per lender (lib/audit/siem/deliver.ts). Every
  // replica may run it: a lender is delivered under an advisory lock.
  { route: "audit-siem-deliver", owner: "in-process", schedule: "*/2 * * * *", freshnessMinutes: 30 },
] as const)
