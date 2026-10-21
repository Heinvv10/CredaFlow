/**
 * Real-Postgres proof of the single-run claim: every replica fires every
 * single-run job, at its time and again 30 and 60 minutes later, and a job runs
 * once per SAST day unless that run FAILED or died (a stale RUNNING claim).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run instrumentation.single-run.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"
import { sastCalendarDate } from "@/lib/date/sast"
import {
  claimCronRun, cronOccurrences, finishCronRun, renewCronClaim, STALE_RUNNING_MINUTES,
} from "@/lib/ops/cron-run-claim"

const schedule = vi.hoisted(() => vi.fn())
vi.mock("node-cron", () => ({ schedule }))

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
// What lib/ops/cron-call.ts returns: the status, the body (or null) and the failed-tenants header (or null).
type Call = { status: number; body: unknown; failedTenants: number | null }
const ok: Call = { status: 200, body: null, failedTenants: 0 }
const fetchMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]): Promise<Call> => ({ status: 200, body: null, failedTenants: 0 })))
vi.mock("@/lib/ops/cron-call", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ops/cron-call")>()), callCronRoute: fetchMock }))
const env = { ...process.env }

const occurrences = cronOccurrences(CRON_JOBS.filter((j) => j.owner === "in-process"))
/** The `attempt`th firing of a job: 0 is its own time, 1 and 2 the +30 and +60 retries. */
/**
 * Reminders wait for escalations to settle, so unless a test is about that wait, escalations is
 * recorded DONE for the (fake) day first.
 */
const fire = async (route: string, attempt = 0, escalationsSettled = true) => {
  const index = occurrences.findIndex((o) => o.job.route === route && o.attempt === attempt)
  if (index < 0) throw new Error(`${route} has no firing ${attempt}`)
  if (route === "reminders" && escalationsSettled) {
    await db.cronRunClaim.createMany({ data: [{ job: "escalations", runDay: sastCalendarDate(new Date()), status: "DONE" }], skipDuplicates: true })
  }
  return (await schedule.mock.calls[index][1]()) as void
}
const callsTo = (route: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(`/api/cron/${route}`)).length
const claim = (job: string, runDay: string) => db.cronRunClaim.findUniqueOrThrow({ where: { job_runDay: { job, runDay } } })

suite.sequential("single-run in-process jobs (real Postgres)", () => {
  beforeAll(async () => {
    process.env.NEXT_RUNTIME = "nodejs"
    process.env.APP_MODE = "staff"
    process.env.CRON_SECRET = "test-secret"
    process.env.NEXTAUTH_URL = "http://cron.test"
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { register } = await import("./instrumentation")
    await register()
    await db.cronRunClaim.deleteMany()
  })
  afterEach(() => {
    vi.useRealTimers()
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => ok)
  })
  afterAll(async () => {
    process.env = env
    vi.restoreAllMocks()
    await db.cronRunClaim.deleteMany()
    await db.$disconnect()
    const { prisma } = await import("@/lib/prisma")
    await prisma.$disconnect()
  })

  it("two replicas firing the same job on the same SAST day produce one run, recorded DONE", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-21T05:00:00Z") })
    await Promise.all([fire("reminders"), fire("reminders")])
    expect(callsTo("reminders")).toBe(1)
    expect(await claim("reminders", "2026-10-21")).toMatchObject({ status: "DONE", attempts: 1 })
  })

  it("a DONE run is not run again by its +30 and +60 minute firings", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-22T05:00:00Z") })
    await fire("escalations")
    vi.setSystemTime(new Date("2026-10-22T05:30:00Z"))
    await fire("escalations", 1)
    vi.setSystemTime(new Date("2026-10-22T06:00:00Z"))
    await fire("escalations", 2)
    expect(callsTo("escalations")).toBe(1)
  })

  it("a run whose HTTP call failed is marked FAILED and the +30 firing runs it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-23T05:00:00Z") })
    fetchMock.mockResolvedValueOnce({ status: 503, body: null, failedTenants: null })
    await fire("reminders")
    expect(await claim("reminders", "2026-10-23")).toMatchObject({ status: "FAILED" })
    vi.setSystemTime(new Date("2026-10-23T05:30:00Z"))
    await fire("reminders", 1)
    expect(callsTo("reminders")).toBe(2)
    expect(await claim("reminders", "2026-10-23")).toMatchObject({ status: "DONE", attempts: 2 })
    vi.setSystemTime(new Date("2026-10-23T06:00:00Z"))
    await fire("reminders", 2)
    expect(callsTo("reminders")).toBe(2)
  })

  it("a tenant that threw (200 partial) makes the run FAILED so the +30 firing retries it", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-12T05:00:00Z") })
    fetchMock.mockResolvedValueOnce({ status: 200, body: { partial: true }, failedTenants: 1 })
    await fire("reminders")
    expect(await claim("reminders", "2026-11-12")).toMatchObject({ status: "FAILED" })
    vi.setSystemTime(new Date("2026-11-12T05:30:00Z"))
    await fire("reminders", 1)
    expect(callsTo("reminders")).toBe(2)
    expect(await claim("reminders", "2026-11-12")).toMatchObject({ status: "DONE", attempts: 2 })
  })

  it("per-item errors (sends that failed, reconciliation cases) leave the run DONE: no retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-13T05:00:00Z") })
    fetchMock.mockResolvedValueOnce({ status: 200, body: { errors: 4, reconciliationRequired: 2 }, failedTenants: 0 })
    await fire("reminders")
    vi.setSystemTime(new Date("2026-11-13T05:30:00Z"))
    await fire("reminders", 1)
    expect(callsTo("reminders")).toBe(1)
    expect(await claim("reminders", "2026-11-13")).toMatchObject({ status: "DONE" })
  })

  // A 2xx that carries no failed-tenants header is indistinguishable from one whose body was over the
  // cap (body null), so a single-run job fails closed on it.
  it("a 2xx without the failed-tenants header is FAILED, and the +30 firing runs it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-15T05:00:00Z") })
    fetchMock.mockResolvedValueOnce({ status: 200, body: null, failedTenants: null })
    await fire("reminders")
    expect(await claim("reminders", "2026-11-15")).toMatchObject({ status: "FAILED" })
    vi.setSystemTime(new Date("2026-11-15T05:30:00Z"))
    await fire("reminders", 1)
    expect(callsTo("reminders")).toBe(2)
  })

  describe("a job that runs `after` another (escalations settles by the clock, not by how many claims it took)", () => {
    const day = "2026-11-14"
    const at = (hhmm: string) => vi.useFakeTimers({ toFake: ["Date"], now: new Date(`2026-11-14T${hhmm}:00Z`) }) // UTC: SAST is +2h
    const seed = (data: { status: "RUNNING" | "DONE" | "FAILED"; attempts: number; claimedAt?: Date }) =>
      db.cronRunClaim.create({ data: { job: "escalations", runDay: day, ...data } })
    const reset = () => db.cronRunClaim.deleteMany({ where: { runDay: day } })

    it("waits while escalations has not run, and while it is running", async () => {
      await reset()
      at("05:30") // 07:30 SAST
      await fire("reminders", 0, false)
      expect(callsTo("reminders"), "escalations has no claim yet").toBe(0)
      at("06:30") // 08:30 SAST: the final firing of escalations is long past, but it is running right now
      await seed({ status: "RUNNING", attempts: 1, claimedAt: new Date() })
      await fire("reminders", 2, false)
      expect(callsTo("reminders"), "escalations is running and its heartbeat is fresh").toBe(0)
      expect(await db.cronRunClaim.count({ where: { job: "reminders", runDay: day } }), "waiting takes no claim").toBe(0)
    })

    it("waits for a retry that is still to come, whatever the claim count", async () => {
      await reset()
      await seed({ status: "FAILED", attempts: 1 })
      at("05:30") // 07:30 SAST, escalations' final firing is 08:00
      await fire("reminders", 0, false)
      at("06:00") // 08:00 SAST: its final firing is happening now
      await fire("reminders", 1, false)
      expect(callsTo("reminders")).toBe(0)
    })

    // The case the old attempts>=3 rule got wrong: the 07:00 firing never happened (a replica was down),
    // so escalations took only two claims (07:30 and 08:00), both failed, and reminders were held for ever.
    it("runs once escalations' final firing has passed, though its first firing was missed and it took only two claims", async () => {
      await reset()
      await seed({ status: "FAILED", attempts: 2 })
      at("06:30") // 08:30 SAST
      await fire("reminders", 2, false)
      expect(callsTo("reminders")).toBe(1)
    })

    it("runs when escalations is DONE, at any time of the morning", async () => {
      await reset()
      await seed({ status: "DONE", attempts: 1 })
      at("05:30")
      await fire("reminders", 0, false)
      expect(callsTo("reminders")).toBe(1)
    })

    it("runs after the final firing when escalations died mid-run: a stale RUNNING claim does not hold reminders back", async () => {
      await reset()
      await seed({ status: "RUNNING", attempts: 1, claimedAt: new Date("2026-11-14T05:00:00Z") })
      at("06:30")
      await fire("reminders", 2, false)
      expect(callsTo("reminders")).toBe(1)
    })
  })

  it("a call that threw (no response) is FAILED too", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-24T05:00:00Z") })
    fetchMock.mockRejectedValueOnce(new Error("connection refused"))
    await fire("escalations")
    await fire("escalations", 1)
    expect(callsTo("escalations")).toBe(2)
  })

  it("two firings racing over a FAILED claim run it once", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-25T05:00:00Z") })
    fetchMock.mockResolvedValueOnce({ status: 500, body: null, failedTenants: null })
    await fire("reminders")
    await Promise.all([fire("reminders", 1), fire("reminders", 1), fire("reminders", 2)])
    expect(callsTo("reminders")).toBe(2)
  })

  it("a RUNNING claim is left alone while fresh, and taken over once stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-26T05:00:00Z") })
    await db.cronRunClaim.create({ data: { job: "reminders", runDay: "2026-10-26", status: "RUNNING", claimedAt: new Date() } })
    await fire("reminders", 1)
    expect(callsTo("reminders")).toBe(0)
    vi.setSystemTime(new Date(Date.now() + (STALE_RUNNING_MINUTES + 1) * 60_000))
    await fire("reminders", 2)
    expect(callsTo("reminders")).toBe(1)
  })

  describe("ownership of a claim", () => {
    const at = (iso: string) => new Date(iso)

    it("an old runner cannot close or renew an attempt that was taken over from it", async () => {
      const t0 = at("2026-11-02T05:00:00Z")
      const first = await claimCronRun("reminders", t0)
      expect(first).toEqual(expect.any(String))
      // The first runner stops renewing (it died, or is partitioned); a later firing takes over.
      const t1 = at("2026-11-02T05:30:00Z")
      const second = await claimCronRun("reminders", t1)
      expect(second).toEqual(expect.any(String))
      expect(second).not.toBe(first)

      // ...then the first runner comes back and tries to speak for the claim.
      expect(await renewCronClaim("reminders", first!, t0, at("2026-11-02T05:31:00Z"))).toBe(false)
      expect(await finishCronRun("reminders", first!, true, t0)).toBe(false)
      expect(await claim("reminders", "2026-11-02")).toMatchObject({ status: "RUNNING", attempts: 2, ownerToken: second })

      expect(await finishCronRun("reminders", second!, false, t1)).toBe(true)
      expect(await claim("reminders", "2026-11-02")).toMatchObject({ status: "FAILED" })
    })

    it("a runner that keeps renewing its claim is never taken over, however long it runs", async () => {
      const t0 = at("2026-11-03T05:00:00Z")
      const token = (await claimCronRun("escalations", t0))!
      for (const minutes of [1, 2, 3, 4, 5, 6]) await renewCronClaim("escalations", token, t0, new Date(t0.getTime() + minutes * 60_000))
      // 7 minutes after the claim, longer than the stale limit, but its last heartbeat is 1 minute old.
      expect(await claimCronRun("escalations", new Date(t0.getTime() + 7 * 60_000))).toBeNull()
    })

    it("a runner whose heartbeat stopped is taken over", async () => {
      const t0 = at("2026-11-04T05:00:00Z")
      await claimCronRun("escalations", t0)
      expect(await claimCronRun("escalations", new Date(t0.getTime() + (STALE_RUNNING_MINUTES - 1) * 60_000))).toBeNull()
      expect(await claimCronRun("escalations", new Date(t0.getTime() + (STALE_RUNNING_MINUTES + 1) * 60_000))).toEqual(expect.any(String))
    })

    it("a wrong token renews and closes nothing", async () => {
      const t0 = at("2026-11-05T05:00:00Z")
      await claimCronRun("reminders", t0)
      expect(await renewCronClaim("reminders", "not-the-token", t0)).toBe(false)
      expect(await finishCronRun("reminders", "not-the-token", true, t0)).toBe(false)
      expect(await claim("reminders", "2026-11-05")).toMatchObject({ status: "RUNNING" })
    })
  })

  it("keys the day in SAST, not UTC: 22:30 UTC is already tomorrow in Johannesburg", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T21:30:00Z") })
    await fire("reminders")
    vi.setSystemTime(new Date("2026-10-27T22:30:00Z"))
    await fire("reminders")
    expect(callsTo("reminders")).toBe(2)
  })

  it("claims each job on its own", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-30T05:00:00Z") })
    await fire("escalations")
    await fire("reminders")
    expect([callsTo("escalations"), callsTo("reminders")]).toEqual([1, 1])
  })

  it("does not claim a job that is not single-run (dpd-update is idempotent)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-29T05:00:00Z") })
    await Promise.all([fire("dpd-update"), fire("dpd-update"), fire("insurance-renewal"), fire("insurance-renewal")])
    expect([callsTo("dpd-update"), callsTo("insurance-renewal")]).toEqual([2, 2])
  })
})
