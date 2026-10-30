import { defineCronJobs } from "../define"

// Not singleRun: it runs often, and its rows are claimed (lib/decisioning/digital-due.ts), so replicas do not repeat work.
export default defineCronJobs([
  { route: "digital-decisions", owner: "in-process", schedule: "*/5 * * * *", freshnessMinutes: 15 },
] as const)
