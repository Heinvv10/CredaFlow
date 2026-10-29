import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"
import { cronOccurrences } from "@/lib/ops/cron-run-claim"

/** The scheduler counts each finished run by outcome (lib/observability/metrics.ts), for /api/metrics. */
const schedule = vi.hoisted(() => vi.fn())
vi.mock("node-cron", () => ({ schedule }))
vi.mock("@/lib/ops/cron-heartbeat", () => ({ recordCronRun: vi.fn() }))
const callCronRoute = vi.hoisted(() => vi.fn())
vi.mock("@/lib/ops/cron-call", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ops/cron-call")>()), callCronRoute }))
const recordCronOutcome = vi.hoisted(() => vi.fn())
vi.mock("@/lib/observability/metrics", () => ({ recordCronOutcome }))

const occurrences = cronOccurrences(CRON_JOBS.flatMap((j) => (j.owner === "in-process" ? [j] : [])))
// A job that takes no run claim, so the call goes straight out.
const plain = occurrences.find((o) => !o.job.singleRun && o.attempt === 0)!
const fire = () => schedule.mock.calls[occurrences.indexOf(plain)][1]() as Promise<void>

describe("cron outcome metrics", () => {
  beforeAll(async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs")
    vi.stubEnv("APP_MODE", "staff")
    vi.stubEnv("CRON_SECRET", "test-secret")
    vi.stubEnv("DEMO_MODE", "false")
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { register } = await import("./instrumentation")
    await register()
  })
  beforeEach(() => recordCronOutcome.mockClear())

  it("records ok for a 2xx", async () => {
    callCronRoute.mockResolvedValue({ status: 200, body: null, failedTenants: 0 })
    await fire()
    expect(recordCronOutcome).toHaveBeenCalledWith(`/api/cron/${plain.job.route}`, "ok")
  })

  it("records failed for a non-2xx", async () => {
    callCronRoute.mockResolvedValue({ status: 503, body: null, failedTenants: null })
    await fire()
    expect(recordCronOutcome).toHaveBeenCalledWith(`/api/cron/${plain.job.route}`, "failed")
  })

  it("records error when the call itself throws", async () => {
    callCronRoute.mockRejectedValue(new Error("ECONNREFUSED"))
    await fire()
    expect(recordCronOutcome).toHaveBeenCalledWith(`/api/cron/${plain.job.route}`, "error")
  })
})
