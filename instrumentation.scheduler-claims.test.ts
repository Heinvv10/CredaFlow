import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"
import { cronOccurrences } from "@/lib/ops/cron-run-claim"

/**
 * How the in-process scheduler (instrumentation.ts) treats a single-run job's claim:
 * what it calls, when it renews, how it closes. The census of which routes exist and
 * who owns them is instrumentation.cron-census.test.ts; the same behaviour against a
 * real database is instrumentation.single-run.integration.test.ts.
 */
const schedule = vi.hoisted(() => vi.fn())
vi.mock("node-cron", () => ({ schedule }))
const ensureActiveJurisdiction = vi.hoisted(() => vi.fn(async () => ({ jurisdiction: "ZA", currency: "ZAR" })))
vi.mock("@/lib/jurisdiction/load.server", () => ({
  bootActiveJurisdiction: vi.fn(async () => ({ jurisdiction: "ZA", currency: "ZAR" })),
  ensureActiveJurisdiction,
}))
vi.mock("@/lib/ops/cron-heartbeat", () => ({ recordCronRun: vi.fn() }))

type Call = { status: number; body: unknown; failedTenants: number | null }
const callCronRoute = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<Call> => ({ status: 200, body: null, failedTenants: 0 })))
vi.mock("@/lib/ops/cron-call", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ops/cron-call")>()), callCronRoute }))
const claimCronRun = vi.hoisted(() => vi.fn(async (_job: string): Promise<string | null> => "tok"))
const finishCronRun = vi.hoisted(() => vi.fn(async (_job: string, _token: string, _ok: boolean) => true))
const renewCronClaim = vi.hoisted(() => vi.fn(async (_job: string, _token: string) => true))
const cronSettledToday = vi.hoisted(() => vi.fn(async (_job: string, _finalFiring: number) => true))
vi.mock("@/lib/ops/cron-run-claim", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ops/cron-run-claim")>()),
  claimCronRun,
  finishCronRun,
  renewCronClaim,
  cronSettledToday,
}))

const occurrences = cronOccurrences(CRON_JOBS.flatMap((j) => (j.owner === "in-process" ? [j] : [])))
const fire = (route: string, attempt = 0) => {
  const index = occurrences.findIndex((o) => o.job.route === route && o.attempt === attempt)
  if (index < 0) throw new Error(`${route} has no firing ${attempt}`)
  return schedule.mock.calls[index][1]() as Promise<void>
}

describe("the scheduler's single-run claims", () => {
  const env = { ...process.env }
  beforeAll(async () => {
    process.env.NEXT_RUNTIME = "nodejs"
    process.env.APP_MODE = "staff"
    process.env.CRON_SECRET = "test-secret"
    process.env.NEXTAUTH_URL = "https://staff.cron.test"
    delete process.env.CRON_BASE_URL
    delete process.env.PORT
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { register } = await import("./instrumentation")
    await register()
  })
  afterAll(() => {
    process.env = env
    vi.restoreAllMocks()
  })
  beforeEach(() => {
    callCronRoute.mockReset()
    callCronRoute.mockResolvedValue({ status: 200, body: null, failedTenants: 0 })
    claimCronRun.mockReset()
    claimCronRun.mockResolvedValue("tok")
    finishCronRun.mockClear()
    renewCronClaim.mockClear()
    cronSettledToday.mockReset()
    cronSettledToday.mockResolvedValue(true)
  })

  // The public origin goes through a TLS proxy (nginx 60 s, Cloudflare 100 s): a 504 would mark a run
  // that is still going FAILED. The call goes to this server on loopback with the public Host header.
  it("learns the lender's jurisdiction before it calls any route (a cron has no request to have loaded it)", async () => {
    ensureActiveJurisdiction.mockClear()
    const order: string[] = []
    ensureActiveJurisdiction.mockImplementationOnce(async () => { order.push("jurisdiction"); return { jurisdiction: "ZA", currency: "ZAR" } })
    callCronRoute.mockImplementationOnce(async () => { order.push("route"); return { status: 200, body: null, failedTenants: 0 } })
    await fire(occurrences[0].job.route, occurrences[0].attempt)
    expect(order.slice(0, 2)).toEqual(["jurisdiction", "route"])
  })

  it("calls the route on loopback, with the public host as Host, not through the public origin", async () => {
    await fire("reminders")
    expect(callCronRoute).toHaveBeenCalledWith("http://127.0.0.1:3300/api/cron/reminders", "GET", "test-secret", { host: "staff.cron.test" })
  })

  it("claims the SAST day before it calls a single-run job, and only then", async () => {
    claimCronRun.mockResolvedValue(null)
    for (const [i, call] of schedule.mock.calls.entries()) {
      const job = occurrences[i].job
      claimCronRun.mockClear()
      finishCronRun.mockClear()
      callCronRoute.mockClear()
      await call[1]()
      const singleRun = job.singleRun === true
      expect(claimCronRun.mock.calls.map((c) => c[0]), job.route).toEqual(singleRun ? [job.route] : [])
      expect(finishCronRun, "a run that was not claimed is not closed").not.toHaveBeenCalled()
      // A lost claim means another replica runs it: this one makes no call.
      expect(callCronRoute.mock.calls.length, job.route).toBe(singleRun ? 0 : 1)
    }
  })

  // Per-item errors are in the body and leave the claim DONE; a tenant that threw is what a retry is
  // for. A 2xx that does not say (no header, or a body past the cap) is not a clean run: fail closed.
  it.each([
    ["a 2xx whose header says no tenant failed", { status: 200, body: { errors: 3, reconciliationRequired: 1 }, failedTenants: 0 }, true],
    ["a 2xx where a tenant threw", { status: 200, body: { partial: true }, failedTenants: 1 }, false],
    ["a 2xx with no failed-tenants header: it cannot be told from a body that was too big to read", { status: 200, body: null, failedTenants: null }, false],
    ["a 503", { status: 503, body: { failedTenants: 2 }, failedTenants: 2 }, false],
    ["a 503 with no header", { status: 503, body: null, failedTenants: null }, false],
  ])("closes the claim for %s as DONE=%s", async (_name, outcome, done) => {
    callCronRoute.mockResolvedValueOnce(outcome)
    await fire("escalations")
    expect(finishCronRun.mock.calls.map((c) => c[2])).toEqual([done])
  })

  it("does not demand the header of a job that has no claim", async () => {
    callCronRoute.mockResolvedValueOnce({ status: 200, body: null, failedTenants: null })
    await fire("dpd-update")
    expect(finishCronRun).not.toHaveBeenCalled()
    expect(claimCronRun).not.toHaveBeenCalled()
  })

  it("renews the claim every minute while the call is in flight, and stops when it returns", async () => {
    vi.useFakeTimers()
    try {
      let finish: (r: Call) => void = () => undefined
      callCronRoute.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      const running = fire("reminders")
      await vi.advanceTimersByTimeAsync(3 * 60_000)
      expect(renewCronClaim.mock.calls.map((c) => c[1])).toEqual(["tok", "tok", "tok"])
      finish({ status: 200, body: null, failedTenants: 0 })
      await running
      await vi.advanceTimersByTimeAsync(3 * 60_000)
      expect(renewCronClaim, "no renewal once the run has returned").toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  // The call has no client timeout (lib/ops/cron-call.ts): a run longer than undici's 300 s default is
  // still running, not failed, and its retry must not overlap it.
  it("a call that takes longer than five minutes keeps its claim alive and closes it DONE", async () => {
    vi.useFakeTimers()
    try {
      let finish: (r: Call) => void = () => undefined
      callCronRoute.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      const running = fire("reminders")
      await vi.advanceTimersByTimeAsync(7 * 60_000)
      expect(finishCronRun, "still running: nothing has closed it").not.toHaveBeenCalled()
      expect(renewCronClaim).toHaveBeenCalledTimes(7)
      finish({ status: 200, body: null, failedTenants: 0 })
      await running
      expect(finishCronRun.mock.calls.map((c) => [c[1], c[2]])).toEqual([["tok", true]])
    } finally {
      vi.useRealTimers()
    }
  })

  // `attempts` counts claims, not firings, so a missed firing must not move the finish line: the gate is
  // told the clock minute of the other job's FINAL scheduled firing.
  it("asks whether the `after` job has settled as of its final scheduled firing, and takes no claim while it has not", async () => {
    const finalFiring = Math.max(...occurrences.filter((o) => o.job.route === "escalations").map((o) => {
      const [minute, hour] = o.schedule.split(" ").map(Number)
      return hour * 60 + minute
    }))
    cronSettledToday.mockResolvedValueOnce(false)
    await fire("reminders")
    expect(cronSettledToday).toHaveBeenCalledWith("escalations", finalFiring)
    expect(callCronRoute).not.toHaveBeenCalled()
    expect(claimCronRun).not.toHaveBeenCalled()
  })

  it("skips a single-run job whose claim cannot be made, rather than risk a duplicate", async () => {
    claimCronRun.mockRejectedValueOnce(new Error("db down"))
    await fire("reminders")
    expect(callCronRoute).not.toHaveBeenCalled()
  })
})
