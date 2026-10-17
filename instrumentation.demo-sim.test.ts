import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { register } from "./instrumentation"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"

const schedule = vi.hoisted(() => vi.fn())
vi.mock("node-cron", () => ({ schedule }))

describe("demo simulator cron ownership", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs")
    vi.stubEnv("APP_MODE", "all")
    vi.stubEnv("CRON_SECRET", "synthetic-cron-secret")
    vi.spyOn(console, "log").mockImplementation(() => {})
    schedule.mockClear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("lets the explicit fake-clock driver own cron in a demo simulator", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    vi.stubEnv("DEMO_SIM_MANUAL_CRON", "true")
    await register()
    expect(schedule).not.toHaveBeenCalled()
  })

  it.each([
    ["false", "true"],
    ["true", "false"],
    ["false", "false"],
  ])("keeps the scheduler for DEMO_MODE=%s and DEMO_SIM_MANUAL_CRON=%s", async (demo, manual) => {
    vi.stubEnv("DEMO_MODE", demo)
    vi.stubEnv("DEMO_SIM_MANUAL_CRON", manual)
    await register()
    expect(schedule).toHaveBeenCalledTimes(CRON_JOBS.filter(job => job.owner === "in-process").length)
  })
})
