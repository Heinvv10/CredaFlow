import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { CRON_JOBS } from "@/lib/registry/generated/cron-jobs"

/**
 * Registry jobs with owner "external" are called by the deployment's scheduler: in the
 * chart, a Kubernetes CronJob each (templates/external-crons.yaml, driven by
 * values.yaml). A new external job with no entry would never run on Kubernetes.
 */
const values = readFileSync(path.join(__dirname, "values.yaml"), "utf8")
const listed = [...values.matchAll(/^\s+- \{ route: ([\w-]+), schedule: "([^"]+)" \}/gm)].map((m) => ({ route: m[1]!, schedule: m[2]! }))

describe("chart externalCrons.jobs", () => {
  it("lists exactly the registry's external jobs", () => {
    const external = CRON_JOBS.filter((job) => job.owner === "external").map((job) => job.route).sort()
    expect(listed.map((job) => job.route).sort()).toEqual(external)
  })

  it("gives every job a five-field cron schedule", () => {
    for (const job of listed) expect(job.schedule.split(" ")).toHaveLength(5)
  })
})
