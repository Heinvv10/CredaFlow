import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"
import { cronOccurrences } from "@/lib/ops/cron-run-claim"

/**
 * Every `/api/cron/*` route must have an owner.
 *
 * The app has TWO schedulers — an external scheduler the deployment provides
 * (it calls the cron routes with the cron secret) and the in-process node-cron
 * registry in `instrumentation.ts` — and a route wired to neither is code that
 * reads as delivered in any audit and never runs: an unscheduled
 * `licence-expiry`, for example, never sends the FAIS 60-day adviser-licence
 * warnings it exists for, while a register scored from code presence alone
 * records the feature as built.
 *
 * This test is the guard. Adding a route under `app/api/cron/` fails the suite
 * until someone declares, in lib/registry/cron-jobs/, who runs it: in-process
 * (instrumentation.ts schedules it), external (the deployment's scheduler) or
 * unwired (with the reason).
 *
 * The registry is an ALLOW-list, never a deny-list: a new route is unowned by
 * default and has to be named to pass. A deny-list would let the next
 * unscheduled route through in silence, which is the exact failure being
 * guarded against.
 */

const CRON_DIR = path.join(__dirname, "app", "api", "cron")
const INSTRUMENTATION = path.join(__dirname, "instrumentation.ts")

const routesOwnedBy = (owner: (typeof CRON_JOBS)[number]["owner"]) =>
  new Set<string>(CRON_JOBS.filter((j) => j.owner === owner).map((j) => j.route))
const inProcessScheduled = () => routesOwnedBy("in-process")
const EXTERNALLY_SCHEDULED = routesOwnedBy("external")
const INTENTIONALLY_UNWIRED = routesOwnedBy("unwired")

function cronRoutes(): string[] {
  return fs
    .readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(CRON_DIR, e.name, "route.ts")))
    .map((e) => e.name)
    .sort()
}

describe("cron route census", () => {
  it("declares an owner for every /api/cron route", () => {
    const declared = new Set<string>(CRON_JOBS.map((j) => j.route))
    const unowned = cronRoutes().filter((r) => !declared.has(r))
    expect(
      unowned,
      `these /api/cron routes have no owner. Declare each in lib/registry/cron-jobs/ ` +
        `as in-process (with a schedule), external, or unwired (with a reason).`,
    ).toEqual([])
  })

  it("has no registry entry for a route that no longer exists", () => {
    // Blind in the other direction otherwise: rename or delete a route and its
    // stale entry keeps the suite green while the external scheduler carries
    // on calling a 404 every night.
    const routes = new Set(cronRoutes())
    const stale = CRON_JOBS.map((j) => j.route).filter((r) => !routes.has(r)).sort()
    expect(stale, "a registry entry names a route that is not on disk — renamed or deleted").toEqual([])
  })

  it("gives every route exactly one owner", () => {
    // A route claimed twice has contradictory owners on record: in-process and
    // external both firing duplicates borrower comms (a Section 129 notice
    // sent twice is a compliance problem), and "unwired" beside a schedule
    // claims a live job does not run. scripts/gen-registries.ts refuses a
    // duplicate; this pins it.
    const routes = CRON_JOBS.map((j) => j.route)
    expect(routes.filter((r, i) => routes.indexOf(r) !== i)).toEqual([])
  })

  it("schedules the FAIS adviser-licence expiry warning", () => {
    // Regression pin for the defect this census was written after: the route
    // existed and worked, and nothing ever called it.
    expect(inProcessScheduled()).toContain("licence-expiry")
  })

  it("schedules the WABA template approval poll", () => {
    // Regression pin. lib/whatsapp-cloud.ts gates every template send on
    // `providerStatus === "APPROVED"`; with this unscheduled, a template Meta
    // approved can stay PENDING and every system-initiated WhatsApp keeps
    // failing WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE.
    expect(inProcessScheduled()).toContain("poll-wa-templates")
  })

  it("keeps poll-wa-templates out of the unwired list", () => {
    // Once listed (or nearly listed) as unwired while it ran.
    expect([...INTENTIONALLY_UNWIRED]).not.toContain("poll-wa-templates")
  })

  it("schedules the nightly dunning chain in-process, not through an external timer", () => {
    // Regression pin: these three once needed a timer nothing in the repo
    // installed, so a stock deploy never reminded or escalated anyone.
    for (const route of ["dpd-update", "escalations", "reminders"]) {
      expect(inProcessScheduled(), route).toContain(route)
      expect([...EXTERNALLY_SCHEDULED], route).not.toContain(route)
    }
  })

  it("has retired the payment-reminders courtesy cron: no owner, no route on disk", () => {
    const declared = CRON_JOBS.map((j) => j.route)
    expect(declared).not.toContain("payment-reminders")
    expect(cronRoutes()).not.toContain("payment-reminders")
  })
})

describe("scheduler cadence", () => {
  const scheduleCalls = () =>
    CRON_JOBS.flatMap((j) => (j.owner === "in-process" ? [{ expr: j.schedule, route: j.route, method: j.method }] : []))

  it("uses no 6-field (seconds) cron expressions", () => {
    // node-cron accepts a 6-field expression and reads the FIRST field as
    // seconds — so "*/15 * * * * *" is every 15 SECONDS, not 15 minutes.
    const secondsBased = scheduleCalls()
      .filter((c) => c.expr.trim().split(/\s+/).length > 5)
      .map((c) => `${c.route}: "${c.expr}"`)
    expect(secondsBased).toEqual([])
  })

  it("polls WABA template approval every 15 minutes over GET", () => {
    // A wrong cadence hammers Meta or checks once a year, and POST hits a
    // GET-only route, which 405s and disables the job with no failing test.
    const call = scheduleCalls().find((c) => c.route === "poll-wa-templates")
    expect(call, "poll-wa-templates is not scheduled").toBeDefined()
    expect(call!.expr).toBe("*/15 * * * *")
    expect(call!.method).toBe("GET")
  })

  it("only ever calls a cron route with a method that route exports", () => {
    // A schedule using POST against a GET-only route 405s forever in silence.
    for (const { route, method } of scheduleCalls()) {
      const src = fs.readFileSync(path.join(CRON_DIR, route, "route.ts"), "utf8")
      expect(
        new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`).test(src),
        `lib/registry/cron-jobs/ calls /api/cron/${route} with ${method}, but that route does not export ${method}`,
      ).toBe(true)
    }
  })
})

// What register() actually hands node-cron, not what the source looks like.
const schedule = vi.hoisted(() => vi.fn())
vi.mock("node-cron", () => ({ schedule }))
const ensureActiveJurisdiction = vi.hoisted(() => vi.fn(async () => ({ jurisdiction: "ZA", currency: "ZAR" })))
vi.mock("@/lib/jurisdiction/load.server", () => ({
  bootActiveJurisdiction: vi.fn(async () => ({ jurisdiction: "ZA", currency: "ZAR" })),
  ensureActiveJurisdiction,
}))
vi.mock("@/lib/ops/cron-heartbeat", () => ({ recordCronRun: vi.fn() }))
// The scheduler's HTTP call (lib/ops/cron-call.ts) and its claims: the behaviour of those is in
// instrumentation.scheduler-claims.test.ts. Here only what is scheduled and what is called.
const callCronRoute = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ status: 200, body: null, failedTenants: 0 })))
vi.mock("@/lib/ops/cron-call", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ops/cron-call")>()), callCronRoute }))
vi.mock("@/lib/ops/cron-run-claim", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ops/cron-run-claim")>()),
  claimCronRun: vi.fn(async () => "tok"),
  finishCronRun: vi.fn(async () => true),
  renewCronClaim: vi.fn(async () => true),
  cronSettledToday: vi.fn(async () => true),
}))

describe("instrumentation register()", () => {
  const env = { ...process.env }
  beforeAll(async () => {
    process.env.NEXT_RUNTIME = "nodejs"
    process.env.APP_MODE = "staff"
    process.env.CRON_SECRET = "test-secret"
    process.env.NEXTAUTH_URL = "http://cron.test"
    delete process.env.CRON_BASE_URL
    delete process.env.PORT
    vi.spyOn(console, "log").mockImplementation(() => {})
    const { register } = await import("./instrumentation")
    await register()
  })
  afterAll(() => {
    process.env = env
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // The in-process jobs at their own time, in registry order, then the +30 and
  // +60 minute retries of the single-run ones.
  const occurrences = cronOccurrences(CRON_JOBS.flatMap((j) => (j.owner === "in-process" ? [j] : [])))

  it("schedules exactly the in-process jobs and their single-run retries, pinned to SAST", () => {
    // The container sets no TZ (`date` reports UTC): an unpinned or wrongly
    // pinned expression fires hours away from the time its entry states.
    expect(schedule.mock.calls.map((c) => c[0])).toEqual(occurrences.map((o) => o.schedule))
    const retries = occurrences.filter((o) => o.attempt > 0)
    expect(retries.length).toBeGreaterThan(0)
    expect(retries.every((o) => o.job.singleRun)).toBe(true)
    for (const call of schedule.mock.calls) expect(call[2]).toEqual({ timezone: "Africa/Johannesburg" })
  })

  it("calls each job's route with its method and the cron secret", async () => {
    for (const [i, call] of schedule.mock.calls.entries()) {
      callCronRoute.mockClear()
      await call[1]()
      const job = occurrences[i].job
      expect(callCronRoute).toHaveBeenCalledWith(`http://127.0.0.1:3300/api/cron/${job.route}`, job.method, "test-secret", { host: "cron.test" })
    }
  })

  it("never calls the retired payment-reminders route", async () => {
    callCronRoute.mockClear()
    for (const call of schedule.mock.calls) await call[1]()
    const urls = callCronRoute.mock.calls.map((c) => String(c[0]))
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.filter((u) => u.includes("payment-reminders"))).toEqual([])
  })

  it("never schedules an external or unwired route", () => {
    const scheduled = new Set<string>(schedule.mock.calls.map((_, i) => occurrences[i].job.route))
    for (const r of [...EXTERNALLY_SCHEDULED, ...INTENTIONALLY_UNWIRED]) expect(scheduled.has(r)).toBe(false)
  })

  it("keeps the boot log's job count honest", () => {
    // The boot line is the only signal an operator reads to confirm what runs.
    const logged = vi.mocked(console.log).mock.calls.map((c) => String(c[0]))
    expect(logged).toContain(`[cron] scheduler registered — ${schedule.mock.calls.length} jobs active`)
  })

  it("keeps one timezone constant rather than scattered literals", () => {
    const src = fs.readFileSync(INSTRUMENTATION, "utf8")
    expect(src).toContain('const SAST = "Africa/Johannesburg"')
    expect([...src.matchAll(/timezone:\s*"Africa\/Johannesburg"/g)]).toHaveLength(0)
  })
})
