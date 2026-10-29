import { describe, expect, it } from "vitest"
import { cronSchedulerEnabled } from "./cron-scheduler-flag"

describe("cronSchedulerEnabled", () => {
  it("is on when CRON_SCHEDULER is unset, so a single-container deploy is unchanged", () => {
    expect(cronSchedulerEnabled({})).toBe(true)
  })

  it.each(["off", "OFF", " off ", "false", "0"])("is off for %j (web replicas of a worker/web split)", (value) => {
    expect(cronSchedulerEnabled({ CRON_SCHEDULER: value })).toBe(false)
  })

  it.each(["on", "true", "1", ""])("is on for %j", (value) => {
    expect(cronSchedulerEnabled({ CRON_SCHEDULER: value })).toBe(true)
  })
})
