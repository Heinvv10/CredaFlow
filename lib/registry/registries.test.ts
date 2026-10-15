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
// The snapshots are those lists as they were before the split, and stay
// frozen: every entry must still be present with the same value and in the
// same relative order. Entries added since are allowed anywhere (the generator
// refuses duplicates), so a feature PR never edits a snapshot; one that
// retires an entry removes it from the snapshot on purpose.
function expectPreserved<T>(actual: readonly T[], expected: readonly T[], key: (item: T) => string) {
  const expectedKeys = new Set(expected.map(key))
  expect(actual.filter((item) => expectedKeys.has(key(item)))).toEqual(expected)
}
const entryKey = (e: readonly [string, unknown]) => e[0]

describe("registry parity with the pre-split lists", () => {
  it("audit actions", () => {
    expectPreserved(Object.entries(AuditAction), snapshot("audit-actions"), entryKey)
  })

  it("tenant-scoped models", () => {
    expectPreserved([...TENANT_SCOPED_MODELS], snapshot("tenant-scoped-models"), (m) => m)
  })

  it("cron jobs: schedules, freshness budgets and census owners", () => {
    const expected = snapshot("cron-jobs")
    const routes = (owner: string) => CRON_JOBS.filter((j) => j.owner === owner).map((j) => j.route)
    const scheduled = CRON_JOBS.flatMap((j) =>
      j.owner === "in-process" ? [{ schedule: j.schedule, route: j.route, method: j.method }] : [],
    )
    expectPreserved(scheduled, expected.scheduled, (j: { route: string }) => j.route)
    expectPreserved(Object.entries(CRON_FRESHNESS_MINUTES), expected.freshnessMinutes, entryKey)
    expectPreserved(routes("external"), expected.externallyScheduled, (r) => r)
    expectPreserved(routes("unwired"), expected.intentionallyUnwired, (r) => r)
  })

  it("simulated integrations", () => {
    expectPreserved(Object.entries(SIMULATED_INTEGRATIONS), snapshot("simulated-integrations"), entryKey)
  })

  it("permissions, server and client maps", () => {
    const expected = snapshot("permissions")
    expectPreserved(Object.entries(CLIENT_PERMISSIONS), expected.client, entryKey)
    expectPreserved(Object.entries(SERVER_PERMISSIONS), expected.server, entryKey)
  })

  it("an entry the snapshot holds cannot move to another owner or value unnoticed", () => {
    // expectPreserved filters by key, so a changed value or owner must still fail:
    // a route moved from in-process to external drops out of `scheduled`.
    expect(() => expectPreserved([["A", "x"]], [["A", "y"]], entryKey)).toThrow()
    expect(() => expectPreserved([], [["A", "y"]], entryKey)).toThrow()
    expect(() => expectPreserved([["B", 1], ["A", 1]], [["A", 1], ["B", 1]], entryKey)).toThrow()
    expect(() => expectPreserved([["A", 1], ["NEW", 2], ["B", 1]], [["A", 1], ["B", 1]], entryKey)).not.toThrow()
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
