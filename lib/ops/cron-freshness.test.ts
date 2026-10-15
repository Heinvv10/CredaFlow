import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { CRON_FRESHNESS_MINUTES } from "./cron-heartbeat"

// /api/health judges each in-process job against a freshness budget. A job
// scheduled without a budget would never be reported stale, and a budget for
// a job no longer scheduled would be reported stale forever.
describe("cron freshness budgets", () => {
  it("names exactly the jobs instrumentation.ts schedules", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "instrumentation.ts"), "utf8")
    const scheduled = [...src.matchAll(/cron\.schedule\(\s*"[^"]+"\s*,\s*\(\)\s*=>\s*callCron\(\s*"\/api\/cron\/([a-z-]+)"/g)].map((m) => m[1])
    expect(Object.keys(CRON_FRESHNESS_MINUTES).sort()).toEqual([...new Set(scheduled)].sort())
  })
})
