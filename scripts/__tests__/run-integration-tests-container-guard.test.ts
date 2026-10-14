import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

// scripts/run-integration-tests.sh must not run against another session's
// database. With IT_CONTAINER set, that container has to own the URL's port
// (`it-db.sh check`, shared with the runner); unset is refused unless CI=true
// or REQUIRE_IT_CONTAINER=0. --check-database-url stops right after the guard,
// so no suite or migration runs here. `docker` is a stub on PATH whose
// `docker port` output comes from STUB_DOCKER_PORT, so no daemon is needed.

const SCRIPT = join(process.cwd(), "scripts", "run-integration-tests.sh")
const IT_DB = join(process.cwd(), "scripts", "it-db.sh")
const LOCAL = "postgresql://postgres:it@127.0.0.1:55999/postgres"

let stubDir = ""
beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "docker-stub-"))
  const stub = join(stubDir, "docker")
  writeFileSync(stub, '#!/usr/bin/env bash\n[[ "$1" == "port" ]] && printf \'%b\\n\' "${STUB_DOCKER_PORT:-}" && exit 0\nexit 1\n')
  chmodSync(stub, 0o755)
})
afterAll(() => rmSync(stubDir, { recursive: true, force: true }))

function env(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: `${stubDir}:${process.env.PATH ?? ""}`, NODE_ENV: "test" as const, ...extra }
}
function runner(url: string, extra: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, "--check-database-url"], {
    env: env({ DATABASE_URL: url, ...extra }),
    encoding: "utf8",
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe("run-integration-tests.sh container guard", () => {
  it("accepts when IT_CONTAINER publishes exactly the URL port", () => {
    const r = runner(LOCAL, { IT_CONTAINER: "mine", STUB_DOCKER_PORT: "127.0.0.1:55999" })
    expect(r).toMatchObject({ status: 0 })
    expect(r.out).toContain("host accepted")
  })

  it("accepts a multi-binding docker port output on the same port", () => {
    const r = runner(LOCAL, { IT_CONTAINER: "mine", STUB_DOCKER_PORT: "0.0.0.0:55999\\n[::]:55999" })
    expect(r).toMatchObject({ status: 0 })
  })

  it("refuses when the container maps a different port", () => {
    const r = runner(LOCAL, { IT_CONTAINER: "mine", STUB_DOCKER_PORT: "127.0.0.1:42133" })
    expect(r.status).toBe(1)
    expect(r.out).toContain("does not own DATABASE_URL port 55999")
  })

  it("refuses when any one binding is on another port", () => {
    const r = runner(LOCAL, { IT_CONTAINER: "mine", STUB_DOCKER_PORT: "127.0.0.1:55999\\n127.0.0.1:1" })
    expect(r.status).toBe(1)
  })

  it("refuses when the container does not exist (docker port prints nothing)", () => {
    const r = runner(LOCAL, { IT_CONTAINER: "ghost", STUB_DOCKER_PORT: "" })
    expect(r.status).toBe(1)
  })

  it("refuses a local URL with IT_CONTAINER unset by default", () => {
    const r = runner(LOCAL)
    expect(r.status).toBe(1)
    expect(r.out).toContain("IT_CONTAINER is unset")
  })

  it("allows IT_CONTAINER unset under CI=true or REQUIRE_IT_CONTAINER=0", () => {
    expect(runner(LOCAL, { CI: "true" })).toMatchObject({ status: 0 })
    expect(runner(LOCAL, { REQUIRE_IT_CONTAINER: "0" })).toMatchObject({ status: 0 })
  })

  it("leaves docker-service hosts alone (compose db/postgres)", () => {
    expect(runner("postgresql://u:p@db:5432/it")).toMatchObject({ status: 0 })
  })
})

describe("it-db.sh check", () => {
  function check(extra: Record<string, string>) {
    const r = spawnSync("bash", [IT_DB, "check"], { env: env(extra), encoding: "utf8" })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }

  it("passes when the container owns the port", () => {
    expect(check({ DATABASE_URL: LOCAL, IT_CONTAINER: "mine", STUB_DOCKER_PORT: "127.0.0.1:55999" })).toMatchObject({ status: 0 })
  })

  it("refuses on another port, and when IT_CONTAINER is missing", () => {
    expect(check({ DATABASE_URL: LOCAL, IT_CONTAINER: "mine", STUB_DOCKER_PORT: "127.0.0.1:42133" }).status).toBe(1)
    expect(check({ DATABASE_URL: LOCAL }).status).toBe(1)
  })
})
