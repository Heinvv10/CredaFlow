import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// The integration suites create and delete tenants, clients and loans, so
// scripts/run-integration-tests.sh refuses a DATABASE_URL on any host but this
// machine or a docker-compose service (`db`, `postgres`), unless
// ALLOW_REMOTE_TEST_DB=1.
// --check-database-url runs only that check, so this test never starts a suite.

const SCRIPT = join(process.cwd(), "scripts", "run-integration-tests.sh")

function check(url: string, env: Record<string, string> = {}) {
  const r = spawnSync("bash", [SCRIPT, "--check-database-url"], {
    env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", REQUIRE_IT_CONTAINER: "0", DATABASE_URL: url, ...env },
    encoding: "utf8",
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

describe("run-integration-tests.sh database host rule", () => {
  it.each([
    "postgresql://u:p@localhost:5432/it",
    "postgresql://u:p@127.0.0.1:55432/it?schema=public",
    "postgresql://u:p@[::1]:5432/it",
    "postgresql://u:p@db:5432/it",
    "postgres://postgres@postgres/it",
    "postgresql://u:p%40x@localhost/it",
  ])("accepts a local or docker-service host: %s", (url) => {
    expect(check(url)).toMatchObject({ status: 0 })
  })

  it.each([
    "postgresql://u:p@db.example.com:5432/it",
    "postgresql://u:p@10.0.0.5:5432/it",
    "postgresql://u:p@localhost.attacker.example/it",
    "postgresql://u:p@127.0.0.1.nip.io/it",
    "postgresql://localhost:x@remote.example:5432/it",
    "postgresql://u:p@[2001:db8::1]:5432/it",
    "not a url",
    // libpq/Prisma let the query string override the host in the authority
    "postgresql://u:p@localhost:5432/it?host=prod.example.com",
    "postgresql://u:p@localhost:5432/it?schema=public&HOST=prod.example.com",
    "postgresql://u:p@localhost:5432/it?hostaddr=10.0.0.5",
    // a percent-encoded key decodes to host=
    "postgresql://u:p@localhost:5432/it?%68ost=prod.example.com",
    "postgresql://u:p@localhost:5432/it?ho%73t=prod.example.com",
    // single-label names resolve through search domains / MagicDNS
    "postgresql://u:p@prodbox:5432/it",
    // numeric forms getaddrinfo turns into a remote address
    "postgresql://u:p@0x0a000005:5432/it",
    "postgresql://u:p@167772165:5432/it",
    "postgresql://u:p@127.1:5432/it",
  ])("refuses any other host: %s", (url) => {
    const r = check(url)
    expect(r.status).toBe(1)
    expect(r.out).toMatch(/Refusing/)
  })

  it("ALLOW_REMOTE_TEST_DB=1 lets a remote host through", () => {
    expect(check("postgresql://u:p@db.example.com:5432/it", { ALLOW_REMOTE_TEST_DB: "1" })).toMatchObject({ status: 0 })
  })
})
