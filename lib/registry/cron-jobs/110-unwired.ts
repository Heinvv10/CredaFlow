import { defineCronJobs } from "../define"

// Deliberately unscheduled, with the reason. Anything listed here is a known
// gap that someone decided not to close — not an oversight.
export default defineCronJobs([
  {
    route: "automation-engine",
    owner: "unwired",
    reason: "No time-based schedule is specified: it runs only when the route is called with the cron secret (there is no run button in Settings → Automation).",
  },
  {
    route: "cleanup-disclosures",
    owner: "unwired",
    reason:
      "Draft FAIS disclosure PDFs accumulate in uploads/disclosures/. " +
      "POPIA-adjacent housekeeping; gates no contractual requirement, so it is not scheduled.",
  },
  {
    route: "bureau-daily",
    owner: "unwired",
    reason:
      "The daily bureau file (lib/bureau-submission). Built but not scheduled: " +
      "registering it on a server is the operator's decision, and nothing is sent until Experian confirms a channel.",
  },
  {
    route: "bureau-monthly",
    owner: "unwired",
    reason:
      "The monthly bureau file (lib/bureau-submission). Built but not scheduled, as " +
      "bureau-daily. When it is, run it early on the 1st: a loan paid or reversed after month end is held.",
  },
] as const)
