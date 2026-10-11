import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"

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
 * This test is the guard. Adding a route under `app/api/cron/` now fails the
 * suite until someone states, in one of the three lists below, who runs it.
 *
 * The lists are ALLOW-lists, never deny-lists: a new route is unowned by
 * default and has to be named to pass. A deny-list would let the next
 * unscheduled route through in silence, which is the exact failure being
 * guarded against.
 */

const CRON_DIR = path.join(__dirname, "app", "api", "cron")
const INSTRUMENTATION = path.join(__dirname, "instrumentation.ts")

/**
 * Endpoints the deployment's external scheduler must invoke (e.g. timers that
 * call the route with the cron secret). Nothing in this repository schedules
 * them, so this list is a written claim about the deployment, not something
 * this test can verify: confirm it against the deployment's scheduler.
 *
 * Routes here MUST NOT also be registered in instrumentation.ts: both
 * schedulers firing means duplicate NCA-mandated borrower comms.
 */
const SYSTEMD_OWNED = new Set([
  "cleanup-notifications",
  "dpd-update",
  "email-poll",
  "escalations",
  "lead-task-reminders",
  "messaging-retry",
  "reminders",
])

/**
 * Deliberately unscheduled, with the reason. Anything listed here is a known
 * gap that someone decided not to close — not an oversight.
 */
const INTENTIONALLY_UNWIRED = new Map([
  [
    "automation-engine",
    "Triggered on demand from Settings → Automation; no time-based schedule is specified.",
  ],
  [
    "cleanup-disclosures",
    "Draft FAIS disclosure PDFs accumulate in uploads/disclosures/. " +
      "POPIA-adjacent housekeeping; gates no contractual requirement, so it is not scheduled.",
  ],
  [
    "bureau-daily",
    "The daily bureau file (lib/bureau-submission). Built but not scheduled: " +
      "registering it on a server is the operator's decision, and nothing is sent until Experian confirms a channel.",
  ],
  [
    "bureau-monthly",
    "The monthly bureau file (lib/bureau-submission). Built but not scheduled, as " +
      "bureau-daily. When it is, run it early on the 1st: a loan paid or reversed after month end is held.",
  ],
  // NOT `payment-reminders`. It duplicates the externally scheduled
  // `reminders` endpoint, but it IS registered in instrumentation.ts and runs
  // nightly. Listing it here would make this census assert that an active
  // borrower-reminder job is inactive.
  // NOT `poll-wa-templates`. It was listed here as "blocked on Meta WABA
  // review — an account that has none", which was true when written and
  // stopped being true when the WABA went live on 2026-08-11. It is now
  // registered in instrumentation.ts; see the note there for why an
  // unscheduled poll silently disables every template send.
])

function cronRoutes(): string[] {
  return fs
    .readdirSync(CRON_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(CRON_DIR, e.name, "route.ts")))
    .map((e) => e.name)
    .sort()
}

function inProcessScheduled(): Set<string> {
  const src = fs.readFileSync(INSTRUMENTATION, "utf8")
  const found = new Set<string>()
  // Only count endpoints reached through an actual cron.schedule() callback —
  // a bare callCron() elsewhere in the file is not a schedule.
  const pattern = /cron\.schedule\(\s*"[^"]+"\s*,\s*\(\)\s*=>\s*callCron\(\s*"\/api\/cron\/([a-z-]+)"/g
  for (const m of src.matchAll(pattern)) {
    found.add(m[1])
  }
  return found
}

describe("cron route census", () => {
  it("schedules every /api/cron route, or names it as deliberately unwired", () => {
    const scheduled = inProcessScheduled()
    const unowned = cronRoutes().filter(
      (r) => !scheduled.has(r) && !SYSTEMD_OWNED.has(r) && !INTENTIONALLY_UNWIRED.has(r),
    )
    expect(
      unowned,
      `these /api/cron routes have no scheduler. Add a cron.schedule() in instrumentation.ts, ` +
        `or add the name to SYSTEMD_OWNED / INTENTIONALLY_UNWIRED with a reason.`,
    ).toEqual([])
  })

  it("has no allow-list entry for a route that no longer exists", () => {
    // The census as first written only looked for routes missing an owner, so
    // it was blind in the other direction: rename or delete a route and its
    // stale allow-list entry keeps the suite green while the external
    // scheduler carries on calling a 404 every night. Both lists must stay subsets of what is on
    // disk.
    const routes = new Set(cronRoutes())
    const staleSystemd = [...SYSTEMD_OWNED].filter((r) => !routes.has(r)).sort()
    const staleUnwired = [...INTENTIONALLY_UNWIRED.keys()].filter((r) => !routes.has(r)).sort()
    expect(
      { staleSystemd, staleUnwired },
      "an allow-list names a route that is not on disk — the endpoint was renamed or deleted",
    ).toEqual({ staleSystemd: [], staleUnwired: [] })
  })

  it("keeps the two allow-lists disjoint", () => {
    // A route claimed by both lists has contradictory owners on record, and
    // whichever claim is wrong is invisible.
    const both = [...SYSTEMD_OWNED].filter((r) => INTENTIONALLY_UNWIRED.has(r)).sort()
    expect(both).toEqual([])
  })

  it("never calls a route 'unwired' while it is scheduled in-process", () => {
    // The census is only worth having if it cannot itself assert something
    // false: a route in INTENTIONALLY_UNWIRED that instrumentation.ts registers
    // would claim a live nightly job does not run.
    const contradictory = [...inProcessScheduled()].filter((r) => INTENTIONALLY_UNWIRED.has(r)).sort()
    expect(
      contradictory,
      "these routes are scheduled in-process but declared intentionally unwired",
    ).toEqual([])
  })

  it("never registers a systemd-owned endpoint in-process as well", () => {
    // Double-firing duplicates borrower comms — a Section 129 notice sent twice
    // is a compliance problem, not a cosmetic one.
    const doubled = [...inProcessScheduled()].filter((r) => SYSTEMD_OWNED.has(r)).sort()
    expect(doubled).toEqual([])
  })

  it("keeps the boot log's job count honest", () => {
    // The scheduler prints its own job count at boot and that line is the only
    // signal an operator reads to confirm what is running. A stale number is a
    // false claim in the logs.
    const src = fs.readFileSync(INSTRUMENTATION, "utf8")
    const claimed = src.match(/scheduler registered — (\d+) jobs active/)
    expect(claimed, "boot log must state how many jobs registered").not.toBeNull()
    expect(Number(claimed![1])).toBe(inProcessScheduled().size)
  })

  it("schedules the FAIS adviser-licence expiry warning", () => {
    // Regression pin for the defect this census was written after: the route
    // existed and worked, and nothing ever called it.
    expect(inProcessScheduled()).toContain("licence-expiry")
  })

  it("schedules the WABA template approval poll", () => {
    // Regression pin. This route is the ONLY writer of
    // MessageTemplate.providerStatus after submission (template-submit.ts
    // writes PENDING and stops), and lib/whatsapp-cloud.ts gates every
    // template send on `providerStatus === "APPROVED"`. The webhook does not
    // help: nothing handles `message_template_status_update` despite the
    // subscription existing at Meta.
    //
    // So with this unscheduled, a template approved by Meta stays PENDING in
    // the database forever and every system-initiated WhatsApp keeps failing
    // WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE — with the Meta dashboard showing
    // "Approved". Registering the templates would look complete and change
    // nothing.
    expect(inProcessScheduled()).toContain("poll-wa-templates")
  })
})

describe("scheduler cadence", () => {
  // The census matched only the ROUTE NAME inside a cron.schedule(), so the
  // cadence and the HTTP method were both free to be anything. Verified by
  // mutation: changing poll-wa-templates to "*/15 * * * * *", to
  // "0 0 1 1 *", or adding "POST", each passed the entire 6241-test suite.
  const scheduleCalls = (): Array<{ expr: string; route: string; method: string }> => {
    const src = fs.readFileSync(INSTRUMENTATION, "utf8")
    const pattern =
      /cron\.schedule\(\s*"([^"]+)"\s*,\s*\(\)\s*=>\s*callCron\(\s*"\/api\/cron\/([a-z-]+)"\s*(?:,\s*"(GET|POST)")?/g
    return [...src.matchAll(pattern)].map((m) => ({ expr: m[1], route: m[2], method: m[3] ?? "GET" }))
  }

  it("uses no 6-field (seconds) cron expressions", () => {
    // node-cron accepts a 6-field expression and reads the FIRST field as
    // seconds — so "*/15 * * * * *" is every 15 SECONDS, not 15 minutes.
    // Confirmed against node-cron@4.2.1. On a job that calls the Meta Graph
    // API once per pending template that is ~52k upstream calls a day.
    const secondsBased = scheduleCalls()
      .filter((c) => c.expr.trim().split(/\s+/).length > 5)
      .map((c) => `${c.route}: "${c.expr}"`)
    expect(
      secondsBased,
      "a 6-field expression makes the first field SECONDS — almost never what the comment beside it claims",
    ).toEqual([])
  })

  it("polls WABA template approval every 15 minutes over GET", () => {
    // Pinned because both halves are silently breakable: a wrong cadence
    // hammers Meta or checks once a year, and POST hits a GET-only route,
    // which 405s and disables the job with no failing test.
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
        `instrumentation.ts calls /api/cron/${route} with ${method}, but that route does not export ${method}`,
      ).toBe(true)
    }
  })
})

describe("scheduler timezone", () => {
  it("pins EVERY schedule to an explicit timezone", () => {
    // The container sets no TZ (`date` reports UTC), so an expression with no `timezone` is read in UTC and the job
    // fires two hours later than the comment beside it claims. An unpinned
    // schedule is not a style problem — it is a job that runs at a different
    // time than the file says it does.
    const src = fs.readFileSync(INSTRUMENTATION, "utf8")
    const schedules = [...src.matchAll(/cron\.schedule\([\s\S]{0,400}?\)\s*(?=\n\n|\n\s*\/\/|\n\s*console)/g)]
    const unpinned = schedules
      .map((m) => m[0])
      .filter((block) => /callCron\(/.test(block) && !/timezone:/.test(block))
      .map((block) => (block.match(/\/api\/cron\/([a-z-]+)/) ?? ["?", "?"])[1])
    expect(
      unpinned,
      "these schedules have no explicit timezone and will run on the container's UTC",
    ).toEqual([])
  })

  it("uses one timezone constant rather than scattered literals", () => {
    const src = fs.readFileSync(INSTRUMENTATION, "utf8")
    expect(src).toContain('const SAST = "Africa/Johannesburg"')
    // A second literal is how one job silently drifts from the rest.
    const literals = [...src.matchAll(/timezone:\s*"Africa\/Johannesburg"/g)]
    expect(literals).toHaveLength(0)
  })

  it("pins every schedule to SAST specifically, not merely to some timezone", () => {
    // The two tests above catch a MISSING timezone and a duplicated SAST
    // literal — but neither catches a WRONG one. Verified by mutation:
    // changing payment-reminders to "America/New_York" passed the whole
    // suite, silently moving live 07:00 borrower reminders by eight hours.
    // Any value that is not the SAST constant is a drift, so assert the
    // identifier rather than enumerating the zones nobody should use.
    const src = fs.readFileSync(INSTRUMENTATION, "utf8")
    const wrong = [...src.matchAll(/timezone:\s*([^,\n}]+)/g)]
      .map((m) => m[1].trim())
      .filter((v) => v !== "SAST")
    expect(wrong, "these schedules use a timezone other than the SAST constant").toEqual([])
  })
})
