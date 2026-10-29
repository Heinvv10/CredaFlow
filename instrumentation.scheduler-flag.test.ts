import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { register } from "./instrumentation"

const schedule = vi.hoisted(() => vi.fn())
vi.mock("node-cron", () => ({ schedule }))

describe("CRON_SCHEDULER (web replicas of a worker/web split)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs")
    vi.stubEnv("APP_MODE", "staff")
    vi.stubEnv("CRON_SECRET", "synthetic-cron-secret")
    vi.stubEnv("DEMO_MODE", "false")
    vi.spyOn(console, "log").mockImplementation(() => {})
    schedule.mockClear()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it("registers nothing when CRON_SCHEDULER=off", async () => {
    vi.stubEnv("CRON_SCHEDULER", "off")
    await register()
    expect(schedule).not.toHaveBeenCalled()
  })

  it("registers the jobs when CRON_SCHEDULER is unset", async () => {
    vi.stubEnv("CRON_SCHEDULER", "")
    await register()
    expect(schedule).toHaveBeenCalled()
  })
})
