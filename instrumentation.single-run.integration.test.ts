/**
 * Real-Postgres proof that a single-run job runs once per SAST day however many
 * replicas fire it: every container with APP_MODE != "client" registers the
 * same node-cron schedule, so two replicas both call the route at 07:00 unless
 * the scheduler claims the (job, day) first.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run instrumentation.single-run.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"

const schedule = vi.hoisted(() => vi.fn())
vi.mock("node-cron", () => ({ schedule }))

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 200 }))
const env = { ...process.env }

const fire = (route: string) => {
  const jobs = CRON_JOBS.filter((j) => j.owner === "in-process")
  const index = jobs.findIndex((j) => j.route === route)
  if (index < 0) throw new Error(`${route} is not scheduled in-process`)
  return schedule.mock.calls[index][1]() as Promise<void>
}
const callsTo = (route: string) => fetchMock.mock.calls.filter((c) => String(c[0]).endsWith(`/api/cron/${route}`)).length

suite.sequential("single-run in-process jobs (real Postgres)", () => {
  beforeAll(async () => {
    process.env.NEXT_RUNTIME = "nodejs"
    process.env.APP_MODE = "staff"
    process.env.CRON_SECRET = "test-secret"
    process.env.NEXTAUTH_URL = "http://cron.test"
    vi.stubGlobal("fetch", fetchMock)
    vi.spyOn(console, "log").mockImplementation(() => undefined)
    const { register } = await import("./instrumentation")
    await register()
    await db.cronRunClaim.deleteMany()
  })
  afterEach(() => {
    vi.useRealTimers()
    fetchMock.mockClear()
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

  it("two replicas firing the same job on the same SAST day produce one run", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-21T05:00:00Z") })
    await Promise.all([fire("reminders"), fire("reminders")])
    expect(callsTo("reminders")).toBe(1)
  })

  it("a later firing on the same SAST day, after the first has finished, does not run it again", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-22T05:00:00Z") })
    await fire("escalations")
    vi.setSystemTime(new Date("2026-10-22T05:00:03Z"))
    await fire("escalations")
    expect(callsTo("escalations")).toBe(1)
  })

  it("keys the day in SAST, not UTC: 22:30 UTC is already tomorrow in Johannesburg", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-23T21:30:00Z") })
    await fire("dpd-update")
    vi.setSystemTime(new Date("2026-10-23T22:30:00Z"))
    await fire("dpd-update")
    expect(callsTo("dpd-update")).toBe(2)
  })

  it("the next day runs again", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-24T05:00:00Z") })
    await fire("reminders")
    vi.setSystemTime(new Date("2026-10-25T05:00:00Z"))
    await fire("reminders")
    expect(callsTo("reminders")).toBe(2)
  })

  it("claims each job on its own: dpd-update, escalations and reminders on the same day all run", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-26T05:00:00Z") })
    await Promise.all([fire("dpd-update"), fire("escalations"), fire("reminders")])
    expect([callsTo("dpd-update"), callsTo("escalations"), callsTo("reminders")]).toEqual([1, 1, 1])
  })

  it("does not claim a job that is not single-run", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T05:00:00Z") })
    await Promise.all([fire("insurance-renewal"), fire("insurance-renewal")])
    expect(callsTo("insurance-renewal")).toBe(2)
  })
})
