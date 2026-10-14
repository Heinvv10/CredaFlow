import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// scripts/run-integration-tests.sh must not run against another session's
// database. With IT_CONTAINER set, that container has to own the URL's port;
// unset it warns (REQUIRE_IT_CONTAINER=1 refuses). --check-database-url stops
// right after the guard, so no suite or migration runs here. A nonexistent
// container name needs no docker daemon: `docker port` fails -> refused.

const SCRIPT = join(process.cwd(), "scripts", "run-integration-tests.sh")
const LOCAL = "postgresql://postgres:it@127.0.0.1:55999/postgres"

function check(url: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, "--check-database-url"], {
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", DATABASE_URL: url, ...env },
    encoding: "utf8",
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe("run-integration-tests.sh container guard", () => {
  it("refuses when IT_CONTAINER does not own the URL port", () => {
    const r = check(LOCAL, { IT_CONTAINER: "cf-it-guard-test-no-such-container" })
    expect(r.status).toBe(1)
    expect(r.out).toContain("does not own DATABASE_URL port 55999")
  })

  it("warns but allows a local URL with IT_CONTAINER unset", () => {
    const r = check(LOCAL)
    expect(r.status).toBe(0)
    expect(r.out).toContain("IT_CONTAINER is unset")
  })

  it("REQUIRE_IT_CONTAINER=1 turns the warning into a refusal", () => {
    const r = check(LOCAL, { REQUIRE_IT_CONTAINER: "1" })
    expect(r.status).toBe(1)
    expect(r.out).toContain("REQUIRE_IT_CONTAINER=1")
  })

  it("leaves docker-service hosts alone (compose db/postgres)", () => {
    const r = check("postgresql://u:p@db:5432/it", { REQUIRE_IT_CONTAINER: "1" })
    expect(r).toMatchObject({ status: 0 })
    expect(r.out).not.toContain("IT_CONTAINER")
  })
})
