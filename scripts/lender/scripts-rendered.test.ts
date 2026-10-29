import { spawnSync } from "node:child_process"
import { cpSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { lender, repo, root, SRC, sh } from "./scripts.test-helpers"

// The deploy gate judges what `compose config` RENDERS, not what the files seem to
// say, and compose runs with a scrubbed environment. These run the REAL compose
// (no docker daemon needed for `config`); skipped where it is not installed.

const compose = spawnSync("sh", ["-c", "docker compose version >/dev/null 2>&1 && echo ok || docker-compose version >/dev/null 2>&1 && echo ok"], { encoding: "utf8" }).stdout.trim()
const realPath = process.env.PATH ?? ""
const S = "s".repeat(40), P = "p".repeat(40)

function realFixture(authEnv: string, extraEnv = "") {
  cpSync(join(SRC, "docker-compose.lender.yml"), join(lender, "docker-compose.yml"))
  writeFileSync(join(lender, ".env"), `${readFileSync(join(lender, ".env"), "utf8")}PORTAL_NEXTAUTH_URL=https://portal.example\n${extraEnv}`)
  writeFileSync(join(lender, "secrets/auth.env"), authEnv)
}
const deploy = (env: Record<string, string> = {}) => sh("deploy.sh", [lender, "cf:new"], { PATH: realPath, ...env })
// Past the config gate the run reaches the image check and stops there (no such image).
const PASSED_GATE = /cannot find or pull|cannot inspect image|No such image/

describe.skipIf(!compose)("deploy gate on the rendered compose config", () => {
  it("refuses a compose file whose app no longer blanks the owner login, whatever .env carries", () => {
    realFixture(`STAFF_AUTH_SECRET=${S}\nPORTAL_AUTH_SECRET=${P}\n`)
    writeFileSync(join(lender, "docker-compose.yml"), readFileSync(join(lender, "docker-compose.yml"), "utf8").replaceAll('POSTGRES_PASSWORD: ""', "POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}"))
    const r = deploy()
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/owner database login/)
  })

  it("accepts distinct secrets (control: the run gets past the gate)", () => {
    realFixture(`STAFF_AUTH_SECRET=${S}\nPORTAL_AUTH_SECRET=${P}\n`)
    expect(deploy().out).toMatch(PASSED_GATE)
  })

  it("refuses equal secrets that differ only by quoting", () => {
    realFixture(`STAFF_AUTH_SECRET="${S}"\nPORTAL_AUTH_SECRET=${S}\n`)
    expect(deploy().out).toMatch(/render EQUAL/)
  })

  it("refuses when a duplicate key later in the file makes them equal (compose takes the last)", () => {
    realFixture(`STAFF_AUTH_SECRET=${S}\nPORTAL_AUTH_SECRET=${P}\nSTAFF_AUTH_SECRET=${P}\n`)
    expect(deploy().out).toMatch(/render EQUAL/)
  })

  it("is not fooled by shell variables: the environment is scrubbed, so the files decide both ways", () => {
    realFixture(`STAFF_AUTH_SECRET=${S}\nPORTAL_AUTH_SECRET=${P}\n`)
    // shell variables that would make them equal are ignored (the deploy proceeds)...
    expect(deploy({ STAFF_AUTH_SECRET: P, PORTAL_AUTH_SECRET: P }).out).toMatch(PASSED_GATE)
    // ...and a shell APP_BIND does not widen the published address
    const r = spawnSync("bash", ["-c", `. ${join(repo, "scripts/lender/lib.sh")}; load_lender ${lender}; lcompose config --format json | jq -r '.services.app.ports[0].host_ip'`], {
      env: { NODE_ENV: "test", PATH: realPath, HOME: root, APP_BIND: "0.0.0.0" }, encoding: "utf8",
    })
    expect(r.stdout.trim()).toBe("127.0.0.1")
  })

  it("refuses a missing portal secret, a short one, and one equal to NEXTAUTH_SECRET", () => {
    realFixture(`STAFF_AUTH_SECRET=${S}\n`)
    expect(deploy().out).toMatch(/cannot render/)
    realFixture(`STAFF_AUTH_SECRET=${S}\nPORTAL_AUTH_SECRET=short\n`)
    expect(deploy().out).toMatch(/at least 32/)
    realFixture(`STAFF_AUTH_SECRET=${S}\nPORTAL_AUTH_SECRET=shared-secret-0123456789abcdef0123456789\n`)
    expect(deploy().out).toMatch(/equal to the shared NEXTAUTH_SECRET/)
  })

  it("refuses a per-host secret that reaches a container through .env", () => {
    realFixture(`STAFF_AUTH_SECRET=${S}\nPORTAL_AUTH_SECRET=${P}\n`, `PORTAL_AUTH_SECRET=${P}\n`)
    expect(deploy().out).toMatch(/reaches a container's environment/)
  })
})
