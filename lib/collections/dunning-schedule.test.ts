import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"
import { cronOccurrences } from "@/lib/ops/cron-run-claim"

/**
 * The nightly dunning jobs are scheduled in-process (docs/DEPLOY.md,
 * "Scheduling"), once a SAST day, in the order their data flows: dpd-update
 * writes the DPD and arrears the other two read; arrangement-check settles
 * which arrangements still hold a loan out of dunning; escalations then
 * reminders send the borrower comms, none of them before 07:00.
 */
const ROOT = path.join(__dirname, "..", "..")

const inProcess = (route: string) => {
  const job = CRON_JOBS.find((j) => j.route === route)
  if (!job || job.owner !== "in-process") throw new Error(`${route} is not scheduled in-process (owner: ${job?.owner ?? "none"})`)
  return job
}

/** Minutes after SAST midnight of a once-a-day "M H * * *" expression. */
function dailyMinuteOfDay(route: string): number {
  const [minute, hour, dom, month, dow] = inProcess(route).schedule.trim().split(/\s+/)
  expect([dom, month, dow], `${route} must run every day`).toEqual(["*", "*", "*"])
  expect(minute, `${route} must run once a day`).toMatch(/^\d+$/)
  expect(hour, `${route} must run once a day`).toMatch(/^\d+$/)
  return Number(hour) * 60 + Number(minute)
}

describe("nightly dunning schedule", () => {
  it("runs dpd-update before escalations, and escalations before reminders", () => {
    const dpd = dailyMinuteOfDay("dpd-update")
    const escalations = dailyMinuteOfDay("escalations")
    const reminders = dailyMinuteOfDay("reminders")
    expect(dpd).toBeLessThan(escalations)
    expect(escalations).toBeLessThan(reminders)
  })

  it("runs dpd-update after the default charges, and reminders after the arrangement check that decides who is on hold", () => {
    expect(dailyMinuteOfDay("default-charges")).toBeLessThan(dailyMinuteOfDay("dpd-update"))
    expect(dailyMinuteOfDay("arrangement-check")).toBeLessThan(dailyMinuteOfDay("reminders"))
  })

  it("leaves at least 15 minutes between dpd-update, escalations and reminders", () => {
    expect(dailyMinuteOfDay("escalations") - dailyMinuteOfDay("dpd-update")).toBeGreaterThanOrEqual(15)
    expect(dailyMinuteOfDay("reminders") - dailyMinuteOfDay("escalations")).toBeGreaterThanOrEqual(15)
  })

  it("sends no borrower message before 07:00 SAST: not at their own time, nor at any retry", () => {
    const occurrences = cronOccurrences(CRON_JOBS.flatMap((j) => (j.owner === "in-process" ? [j] : [])))
    for (const route of ["escalations", "reminders"]) {
      const times = occurrences.filter((o) => o.job.route === route).map((o) => {
        const [minute, hour] = o.schedule.split(" ").map(Number)
        return hour * 60 + minute
      })
      expect(times.length, `${route} is fired at its time and twice more`).toBe(3)
      for (const minuteOfDay of times) expect(minuteOfDay, `${route} fires before 07:00`).toBeGreaterThanOrEqual(7 * 60)
    }
  })

  // Escalations' retries (07:30, 08:00) overlap reminders' own times, so ordering is not left to the clock:
  // reminders wait until escalations has settled (DONE, or out of firings) and so see its DEFAULTED flips.
  it("gates reminders on escalations having settled today", () => {
    expect(inProcess("reminders")).toMatchObject({ after: "escalations" })
    expect(inProcess("escalations")).toMatchObject({ after: null })
    expect(inProcess("escalations").schedule).not.toBe(inProcess("reminders").schedule)
  })

  it.each(["escalations", "reminders"])("%s sends borrower comms, so it runs on one replica a day", (route) => {
    expect(inProcess(route)).toMatchObject({ singleRun: true })
  })

  it("lets every replica run dpd-update: it is idempotent, and the other two make sure it is done", () => {
    expect(inProcess("dpd-update")).toMatchObject({ singleRun: false })
  })

  it("has retired the payment-reminders courtesy cron: no route, no schedule, no owner", () => {
    expect(fs.existsSync(path.join(ROOT, "app", "api", "cron", "payment-reminders"))).toBe(false)
    expect(CRON_JOBS.map((j) => j.route)).not.toContain("payment-reminders")
  })

  // The scheduler fails closed on a single-run job whose 2xx carries no x-cron-failed-tenants header, so a
  // single-run route that stops sending it would make every night's run FAILED and retried. The route tests
  // pin the count; this pins that no single-run route is left without the header.
  it("every single-run job's route sets the failed-tenants header", () => {
    const singleRun = CRON_JOBS.flatMap((j) => (j.owner === "in-process" && j.singleRun ? [j.route] : []))
    expect(singleRun.length).toBeGreaterThan(0)
    for (const route of singleRun) {
      const src = fs.readFileSync(path.join(ROOT, "app", "api", "cron", route, "route.ts"), "utf8")
      expect(src, `${route} must import FAILED_TENANTS_HEADER from @/lib/ops/cron-call`).toMatch(/import \{[^}]*FAILED_TENANTS_HEADER[^}]*\} from "@\/lib\/ops\/cron-call"/)
      expect(src, `${route} must set [FAILED_TENANTS_HEADER] on its response`).toMatch(/headers:\s*\{\s*\[FAILED_TENANTS_HEADER\]:/)
    }
  })
})
