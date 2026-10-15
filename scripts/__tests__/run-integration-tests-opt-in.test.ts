import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// The CI integration job runs every suite through scripts/run-integration-tests.sh, which
// exports every RUN_*_IT it finds. The lender build-context and image-PDF suites build real
// Docker images and run the job out of memory, so their gate must stay opt-in: not exported, not in the gated
// set, and named in the output so it is never silently dropped.

const SCRIPT = join(process.cwd(), "scripts", "run-integration-tests.sh")
const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_ENV: "test", REQUIRE_IT_CONTAINER: "0", DATABASE_URL: "postgresql://u:p@127.0.0.1:55432/it" }
// Each run walks the repo with find and forks one grep per integration suite (~190): about
// 0.6 s idle, measured up to 5.1 s with a parallel suite running, past vitest's 5 s default.
// The spawn's own timeout sits below the test's, so a real hang reports as a spawn timeout.
const SPAWN_TIMEOUT_MS = 50_000
const run = (arg: string) => spawnSync("bash", [SCRIPT, arg], { env, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS })

describe("run-integration-tests.sh opt-in suites", { timeout: 60_000 }, () => {
  it("lists the docker-build suites as opt-in", () => {
    const r = run("--print-opt-in")
    expect(r.status).toBe(0)
    expect(r.stdout).toContain("scripts/lender/build-context.integration.test.ts  (RUN_DOCKER_BUILD_IT=1)")
    expect(r.stdout).toContain("lib/documents/html-to-pdf.image.integration.test.ts  (RUN_DOCKER_BUILD_IT=1)")
  })

  it("lists nothing else: every other suite stays gated", () => {
    const lines = run("--print-opt-in").stdout.trim().split("\n").filter(Boolean)
    expect(lines).toHaveLength(2)
  })

  it("exports every other RUN_*_IT but never the opt-in one", () => {
    const r = run("--print-exports")
    expect(r.status).toBe(0)
    const vars = r.stdout.trim().split("\n")
    expect(vars).not.toContain("RUN_DOCKER_BUILD_IT")
    expect(vars).toContain("RUN_DB_IT")
    expect(vars.length).toBeGreaterThan(5)
  })

  it("names the opt-in suites in its summary instead of dropping them silently", () => {
    expect(readFileSync(SCRIPT, "utf8")).toMatch(/opt-in, NOT run by this gate/)
  })

  it("an opt-in file is no longer part of the baseline logic: the ratchet files are untouched", () => {
    const base = spawnSync("bash", [SCRIPT, "--print-baseline"], { env, encoding: "utf8", timeout: SPAWN_TIMEOUT_MS })
    expect(base.status).toBe(0)
    expect(base.stdout).not.toContain("build-context")
  })
})
