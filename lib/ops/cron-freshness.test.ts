import { describe, expect, it } from "vitest"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"
import { CRON_FRESHNESS_MINUTES } from "./cron-heartbeat"

// /api/health judges each in-process job against a freshness budget. A job
// scheduled without a budget would never be reported stale, and a budget for
// a job no longer scheduled would be reported stale forever.
describe("cron freshness budgets", () => {
  it("names exactly the jobs instrumentation.ts schedules, each with a positive budget", () => {
    const scheduled = CRON_JOBS.filter((j) => j.owner === "in-process").map((j) => j.route)
    expect(Object.keys(CRON_FRESHNESS_MINUTES)).toEqual(scheduled)
    for (const minutes of Object.values(CRON_FRESHNESS_MINUTES)) expect(minutes).toBeGreaterThan(0)
  })
})
