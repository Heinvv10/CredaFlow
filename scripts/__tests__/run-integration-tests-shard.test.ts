import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// CI runs the integration gate as IT_SHARD=i/n jobs. A file that lands in no shard
// is a suite the gate silently stopped running, and a file in two shards wastes a
// job's time; either way every shard is still green. These tests pin the partition.

const SCRIPT = join(process.cwd(), "scripts", "run-integration-tests.sh")
const base: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_ENV: "test", REQUIRE_IT_CONTAINER: "0", DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/it" }
// Same budget as run-integration-tests-opt-in.test.ts: one find plus a grep per suite.
const SPAWN_TIMEOUT_MS = 50_000
const select = (shard?: string) => {
  const r = spawnSync("bash", [SCRIPT, "--print-selected"], { env: shard ? { ...base, IT_SHARD: shard } : base, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS })
  return { status: r.status, stderr: r.stderr, files: r.stdout.split("\n").filter(Boolean) }
}

describe("run-integration-tests.sh IT_SHARD", { timeout: 120_000 }, () => {
  const all = select()

  it("selects every discovered suite when unsharded", () => {
    expect(all.status).toBe(0)
    expect(all.files.length).toBeGreaterThan(100)
    expect(all.files).toContain("prisma/seed.integration.test.ts")
  })

  it.each([2, 3])("puts every suite in exactly one of %i shards", (n) => {
    const shards = Array.from({ length: n }, (_, i) => select(`${i + 1}/${n}`))
    for (const s of shards) {
      expect(s.status).toBe(0)
      expect(s.files.length).toBeGreaterThan(0)
    }
    const union = shards.flatMap((s) => s.files)
    expect(new Set(union).size).toBe(union.length)
    expect([...union].sort()).toEqual([...all.files].sort())
  })

  it("is deterministic", () => {
    expect(select("2/3").files).toEqual(select("2/3").files)
  })

  it("spreads the heaviest suites across shards", () => {
    const heavy = ["prisma/seed.integration.test.ts", "lib/collections/reminders.consent.integration.test.ts", "lib/collections/reminders.identity.integration.test.ts"]
    const owner = heavy.map((f) => [1, 2, 3].find((i) => select(`${i}/3`).files.includes(f)))
    expect(new Set(owner).size).toBe(3)
  })

  it.each(["0/3", "4/3", "1", "a/b", "1/0"])("refuses IT_SHARD=%s", (shard) => {
    const r = select(shard)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain("IT_SHARD must be i/n")
  })
})
