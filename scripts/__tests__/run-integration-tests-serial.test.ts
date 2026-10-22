import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// The integration gate runs its suites one file at a time on one database. vitest's
// --no-file-parallelism is overridden by VITEST_MAX_WORKERS / VITEST_MAX_THREADS in the
// environment, so the runner pins them before it calls vitest (a shell exporting
// VITEST_MAX_WORKERS=4 otherwise runs four suites at once and they deadlock).
const SCRIPT = readFileSync(join(process.cwd(), "scripts", "run-integration-tests.sh"), "utf8")

describe("run-integration-tests.sh runs suites one at a time", () => {
  it("pins vitest to one worker before it runs the gated suites", () => {
    const pin = SCRIPT.indexOf("export VITEST_MAX_WORKERS=1")
    const unsetThreads = SCRIPT.indexOf("unset VITEST_MAX_THREADS")
    const gate = SCRIPT.indexOf('npx vitest run --no-file-parallelism "${GATED[@]}"')
    expect(pin).toBeGreaterThan(0)
    expect(unsetThreads).toBeGreaterThan(0)
    expect(gate).toBeGreaterThan(pin)
    expect(gate).toBeGreaterThan(unsetThreads)
  })
})
