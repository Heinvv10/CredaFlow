import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"

/**
 * The nightly dunning jobs are scheduled in-process (docs/DEPLOY.md,
 * "Scheduling"), once a SAST day, in the order their data flows: dpd-update
 * writes the DPD and arrears the other two read; arrangement-check settles
 * which arrangements still hold a loan out of dunning; escalations then
 * reminders send the borrower comms.
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

  it("leaves a gap between the jobs that a run on a large book cannot overrun", () => {
    expect(dailyMinuteOfDay("escalations") - dailyMinuteOfDay("dpd-update")).toBeGreaterThanOrEqual(15)
    expect(dailyMinuteOfDay("reminders") - dailyMinuteOfDay("escalations")).toBeGreaterThanOrEqual(15)
  })

  it.each(["dpd-update", "escalations", "reminders"])("%s runs on one replica a day", (route) => {
    expect(inProcess(route)).toMatchObject({ singleRun: true })
  })

  it("has retired the payment-reminders courtesy cron: no route, no schedule, no owner", () => {
    expect(fs.existsSync(path.join(ROOT, "app", "api", "cron", "payment-reminders"))).toBe(false)
    expect(CRON_JOBS.map((j) => j.route)).not.toContain("payment-reminders")
  })
})
