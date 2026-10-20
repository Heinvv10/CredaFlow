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
import {
  claimCronRun, cronOccurrences, finishCronRun, releaseReservation, renewCronClaim, reserveOnce, STALE_RUNNING_MINUTES,
} from "@/lib/ops/cron-run-claim"

const schedule = vi.hoisted(() => vi.fn())
vi.mock("node-cron", () => ({ schedule }))

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }))
const env = { ...process.env }

const occurrences = cronOccurrences(CRON_JOBS.filter((j) => j.owner === "in-process"))
/** The `attempt`th firing of a job: 0 is its own time, 1 and 2 the +30 and +60 retries. */
const fire = (route: string, attempt = 0) => {
  const index = occurrences.findIndex((o) => o.job.route === route && o.attempt === attempt)
  if (index < 0) throw new Error(`${route} has no firing ${attempt}`)
  return schedule.mock.calls[index][1]() as Promise<void>
}
const callsTo = (route: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(`/api/cron/${route}`)).length
const claim = (job: string, runDay: string) => db.cronRunClaim.findUniqueOrThrow({ where: { job_runDay: { job, runDay } } })

suite.sequential("single-run in-process jobs (real Postgres)", () => {
  beforeAll(async () => {
    process.env.NEXT_RUNTIME = "nodejs"
    process.env.APP_MODE = "staff"
    process.env.CRON_SECRET = "test-secret"
    process.env.NEXTAUTH_URL = "http://cron.test"
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const { register } = await import("./instrumentation")
    await register()
    await db.cronRunClaim.deleteMany()
  })
  afterEach(() => {
    vi.useRealTimers()
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }))
  })
  afterAll(async () => {
    process.env = env
    vi.unstubAllGlobals()
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
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }))
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

  it("a call that threw (no response) is FAILED too", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-24T05:00:00Z") })
    fetchMock.mockRejectedValueOnce(new Error("connection refused"))
    await fire("escalations")
    await fire("escalations", 1)
    expect(callsTo("escalations")).toBe(2)
  })

  it("two firings racing over a FAILED claim run it once", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-25T05:00:00Z") })
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))
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

  describe("per-message reservations (the backstop)", () => {
    it("of racing reservations for one message on one day, exactly one wins", async () => {
      const day = new Date("2026-11-06T05:00:00Z")
      const wins = await Promise.all([1, 2, 3, 4].map(() => reserveOnce("send:loan_x:reminder_7d:whatsapp", day)))
      expect(wins.filter(Boolean)).toHaveLength(1)
      expect(await reserveOnce("send:loan_x:reminder_7d:whatsapp", new Date("2026-11-06T18:00:00Z"))).toBe(false)
    })

    it("is per message and per SAST day, and a released reservation can be taken again", async () => {
      const day = new Date("2026-11-07T05:00:00Z")
      expect(await reserveOnce("send:loan_y:reminder_7d:sms", day)).toBe(true)
      expect(await reserveOnce("send:loan_y:reminder_7d:whatsapp", day), "another channel").toBe(true)
      expect(await reserveOnce("send:loan_y:reminder_7d:sms", new Date("2026-11-08T05:00:00Z")), "the next day").toBe(true)
      await releaseReservation("send:loan_y:reminder_7d:sms", day)
      expect(await reserveOnce("send:loan_y:reminder_7d:sms", day)).toBe(true)
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
    await Promise.all([fire("escalations"), fire("reminders")])
    expect([callsTo("escalations"), callsTo("reminders")]).toEqual([1, 1])
  })

  it("does not claim a job that is not single-run (dpd-update is idempotent)", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-29T05:00:00Z") })
    await Promise.all([fire("dpd-update"), fire("dpd-update"), fire("insurance-renewal"), fire("insurance-renewal")])
    expect([callsTo("dpd-update"), callsTo("insurance-renewal")]).toEqual([2, 2])
  })
})
