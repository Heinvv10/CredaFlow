import { HOUR, defineCronJobs } from "../define"

export default defineCronJobs([
  // Escalates approvals that are overdue at their level (lib/approval/escalation.ts). Not singleRun, which is once a day: a case is
  // claimed by an optimistic update on its due time, so replicas never escalate the same overdue level twice.
  { route: "approval-escalations", owner: "in-process", schedule: "*/15 * * * *", freshnessMinutes: 2 * HOUR },
] as const)
