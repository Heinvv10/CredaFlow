import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { AuditAction } from "@/lib/audit"
import { CRON_FRESHNESS_MINUTES } from "@/lib/ops/cron-heartbeat"
import { TENANT_SCOPED_MODELS } from "@/lib/tenant-scope"
import { buildRegistries } from "@/scripts/gen-registries"
import { CRON_JOBS } from "./generated/cron-jobs"
import { CLIENT_PERMISSIONS, SERVER_PERMISSIONS } from "./generated/permissions"
import { SIMULATED_INTEGRATIONS } from "./generated/simulated-integrations"

const ROOT = join(__dirname, "..", "..")
const snapshot = (name: string) => JSON.parse(readFileSync(join(__dirname, "__snapshots__", `${name}.json`), "utf8"))

// The lists were moved out of their modules into lib/registry/<kind>/ files.
// Each must still hold exactly the values it held before, in the same order —
// a dropped, duplicated or reordered entry fails here.
describe("registry parity with the pre-split lists", () => {
  it("audit actions", () => {
    expect(Object.entries(AuditAction)).toEqual(snapshot("audit-actions"))
  })

  it("tenant-scoped models", () => {
    expect([...TENANT_SCOPED_MODELS]).toEqual(snapshot("tenant-scoped-models"))
  })

  it("cron jobs: schedules, freshness budgets and census owners", () => {
    const routes = (owner: string) => CRON_JOBS.filter((j) => j.owner === owner).map((j) => j.route)
    expect({
      scheduled: CRON_JOBS.flatMap((j) =>
        j.owner === "in-process" ? [{ schedule: j.schedule, route: j.route, method: j.method }] : [],
      ),
      freshnessMinutes: Object.entries(CRON_FRESHNESS_MINUTES),
      externallyScheduled: routes("external"),
      intentionallyUnwired: routes("unwired"),
    }).toEqual(snapshot("cron-jobs"))
  })

  it("simulated integrations", () => {
    expect(Object.entries(SIMULATED_INTEGRATIONS)).toEqual(snapshot("simulated-integrations"))
  })

  it("permissions, server and client maps", () => {
    expect({ client: Object.entries(CLIENT_PERMISSIONS), server: Object.entries(SERVER_PERMISSIONS) }).toEqual(
      snapshot("permissions"),
    )
  })
})

describe("generated registries", () => {
  it("on disk match the entry files (run npm run gen:registries if not)", async () => {
    const outputs = await buildRegistries()
    for (const [rel, content] of Object.entries(outputs)) {
      expect(readFileSync(join(ROOT, rel), "utf8"), `${rel} is stale`).toBe(content)
    }
  })
})
