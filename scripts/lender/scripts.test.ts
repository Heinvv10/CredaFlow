import { spawnSync } from "node:child_process"
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

// The lender shell scripts against stubs. docker, curl and sleep are shell
// stubs on PATH that answer what the scripts ask and log every docker call;
// gpg and flock are real. The scripts are copied into a throwaway git repo so
// their REPO_ROOT (the checkout they build from) is under test control.
// The real Docker run is the proof in docs/DEPLOY.md; this pins the ORDER and
// the GUARDS.

const SRC = __dirname
let root: string
let repo: string
let lender: string
let log: string

const DOCKER = String.raw`#!/bin/sh
echo "$* APP_IMAGE=$APP_IMAGE" >> "$STUB_LOG"
case "$*" in
  "compose version") exit 0 ;;
  "image inspect -f "*) case "$*" in *new*) echo "GIT_SHA=$STUB_COMMIT_NEW" ;; *) echo "GIT_SHA=$STUB_COMMIT_OLD" ;; esac ;;
  "image inspect "*) exit 0 ;;
  *"pg_dump"*) printf 'PGDMP-stub-%s' "$$" ;;
  *"pg_restore --list"*) d="$(cat)"; case "$d" in PGDMP*) ;; *) exit 1 ;; esac ;;
  *"pg_restore"*) cat > /dev/null ;;
  *"to_regclass"*) echo "$STUB_HAS_MIGRATIONS" ;;
  *"FILTER"*) echo "0|5" ;;
  *"count(*) FROM \"Tenant\""*|*"Tenant="*) printf 'Tenant=1\nUser=1\nmigrations=5\n' ;;
  "run --rm "*) exit "$STUB_MIGRATE_RC" ;;
esac
exit 0
`
// Health follows whichever image state/image.env currently names: "bad" images never answer.
const CURL = String.raw`#!/bin/sh
img="$(sed -n 's/^APP_IMAGE=//p' "$STUB_LENDER/state/image.env" 2>/dev/null)"
case "$img" in *bad*) exit 22 ;; *new*) h="$STUB_HEALTH_COMMIT"; [ -n "$h" ] || h="$STUB_COMMIT_NEW"; st="$STUB_HEALTH_STATUS"; [ -n "$st" ] || st=ok; echo "{\"status\":\"$st\",\"commit\":\"$h\"}" ;; *) echo "{\"status\":\"ok\",\"commit\":\"$STUB_COMMIT_OLD\"}" ;; esac
`

function sh(cmd: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bash", [join(repo, "scripts/lender", cmd), ...args], {
    env: {
      NODE_ENV: "test", PATH: `${join(root, "bin")}:${process.env.PATH ?? ""}`, HOME: root, GNUPGHOME: join(root, "gnupg"),
      STUB_LOG: log, STUB_LENDER: lender, STUB_COMMIT_NEW: "newsha", STUB_COMMIT_OLD: "oldsha",
      STUB_HAS_MIGRATIONS: "t", STUB_MIGRATE_RC: "0", ...env,
    },
    encoding: "utf8",
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls: readFileSync(log, "utf8").split("\n") }
}
const git = (...a: string[]) => spawnSync("git", ["-C", repo, ...a], { encoding: "utf8" })
const state = (f: string) => (existsSync(join(lender, "state", f)) ? readFileSync(join(lender, "state", f), "utf8").trim() : null)
const idx = (calls: string[], needle: string) => calls.findIndex((c) => c.includes(needle))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lender-sh-"))
  repo = join(root, "repo"); lender = join(root, "lender"); log = join(root, "docker.log")
  mkdirSync(join(repo, "scripts"), { recursive: true }); mkdirSync(join(root, "bin")); mkdirSync(join(root, "gnupg"), { mode: 0o700 })
  cpSync(SRC, join(repo, "scripts/lender"), { recursive: true, filter: (s) => !s.endsWith(".test.ts") })
  writeFileSync(log, "")
  for (const [n, body] of [["docker", DOCKER], ["curl", CURL], ["sleep", "#!/bin/sh\nexit 0\n"]]) {
    writeFileSync(join(root, "bin", n), body); chmodSync(join(root, "bin", n), 0o755)
  }
  git("init", "-q"); git("add", "scripts"); git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init")
  mkdirSync(join(lender, "secrets"), { recursive: true }); mkdirSync(join(lender, "backups")); mkdirSync(join(lender, "state"))
  writeFileSync(join(lender, "secrets/backup.passphrase"), "test-passphrase\n")
  writeFileSync(join(lender, ".env"), "NEXT_PUBLIC_TENANT_SLUG=stub-lender\nPOSTGRES_USER=u\nPOSTGRES_DB=d\nPOSTGRES_PASSWORD=p\nAPP_PORT=3999\n")
  writeFileSync(join(lender, "docker-compose.yml"), "services: {}\n")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe("deploy.sh", () => {
  it("refuses --build from a dirty tree before any docker build", () => {
    writeFileSync(join(repo, "untracked.txt"), "x")
    const r = sh("deploy.sh", [lender, "cf:new", "--build"])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/dirty/)
    expect(r.calls.some((c) => c.startsWith("build"))).toBe(false)
  })

  it("builds both targets from a clean tree", () => {
    sh("deploy.sh", [lender, "cf:new", "--build"])
    const builds = readFileSync(log, "utf8").split("\n").filter((c) => c.startsWith("build"))
    expect(builds).toHaveLength(2)
    expect(builds[0]).toContain("--target runner -t cf:new")
    expect(builds[1]).toContain("--target builder -t cf-tools:new")
    expect(builds[0]).toContain("NEXT_PUBLIC_TENANT_SLUG=stub-lender")
  })

  it("backs up, migrates, then switches, in that order, and records the image", () => {
    const r = sh("deploy.sh", [lender, "cf:new"])
    expect(r.status).toBe(0)
    const dump = idx(r.calls, "pg_dump"), migrate = idx(r.calls, "migrate deploy"), up = idx(r.calls, "up -d --no-deps app")
    expect(dump).toBeGreaterThan(-1)
    expect(migrate).toBeGreaterThan(dump)
    expect(up).toBeGreaterThan(migrate)
    expect(state("current-image")).toBe("cf:new")
    expect(readdirSync(join(lender, "backups")).filter((f) => f.endsWith(".dump.gpg"))).toHaveLength(1)
    expect(state("deploys.log")).toMatch(/DEPLOYED/)
  })

  it("does not switch the app when the migration fails", () => {
    writeFileSync(join(lender, "state/current-image"), "cf:old\n")
    const r = sh("deploy.sh", [lender, "cf:new"], { STUB_MIGRATE_RC: "1" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/NOT switched/)
    expect(r.calls.some((c) => c.includes("up -d --no-deps app"))).toBe(false)
    expect(state("current-image")).toBe("cf:old")
  })

  it("aborts before migrating when the backup fails", () => {
    rmSync(join(lender, "secrets/backup.passphrase"))
    const r = sh("deploy.sh", [lender, "cf:new"])
    expect(r.status).not.toBe(0)
    expect(r.calls.some((c) => c.includes("migrate deploy"))).toBe(false)
  })

  it("rolls back to the previous image when the new one is unhealthy", () => {
    writeFileSync(join(lender, "state/current-image"), "cf:old\n")
    const r = sh("deploy.sh", [lender, "cf:bad", "--health-timeout", "1"])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/ROLLED BACK to cf:old/)
    expect(readFileSync(join(lender, "state/image.env"), "utf8")).toContain("APP_IMAGE=cf:old")
    expect(state("current-image")).toBe("cf:old")
    expect(state("deploys.log")).toMatch(/ROLLED_BACK/)
  })

  it("treats a commit in /api/health that is not the image's own as a failed health check", () => {
    writeFileSync(join(lender, "state/current-image"), "cf:old\n")
    const r = sh("deploy.sh", [lender, "cf:new", "--health-timeout", "1"], { STUB_HEALTH_COMMIT: "someone-elses-sha" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/ROLLED BACK to cf:old/)
  })

  it("treats HTTP 200 with a status other than ok (database down) as a failed health check", () => {
    writeFileSync(join(lender, "state/current-image"), "cf:old\n")
    const r = sh("deploy.sh", [lender, "cf:new", "--health-timeout", "1"], { STUB_HEALTH_STATUS: "error" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/ROLLED BACK to cf:old/)
  })

  it("lets state/image.env win: no APP_IMAGE in the environment once an image is deployed", () => {
    const r = sh("deploy.sh", [lender, "cf:new"])
    expect(r.calls.filter((c) => c.includes("up -d --no-deps app")).every((c) => c.endsWith("APP_IMAGE="))).toBe(true)
  })

  it("stops the app when the very first deploy is unhealthy", () => {
    const r = sh("deploy.sh", [lender, "cf:bad", "--health-timeout", "1"])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/no previous image/)
    expect(r.calls.some((c) => c.includes("stop app"))).toBe(true)
  })
})

describe("backup.sh", () => {
  it("writes an encrypted dump with a counts sidecar and keeps only the newest N", () => {
    for (const d of ["20200101T000001Z", "20200101T000002Z", "20200101T000003Z"]) {
      writeFileSync(join(lender, "backups", `stub-lender-${d}.dump.gpg`), "old")
      writeFileSync(join(lender, "backups", `stub-lender-${d}.dump.gpg.counts`), "old")
    }
    const r = sh("backup.sh", [lender, "--keep", "2"])
    expect(r.status).toBe(0)
    const files = readdirSync(join(lender, "backups")).filter((f) => f.endsWith(".dump.gpg")).sort()
    expect(files).toHaveLength(2)
    expect(files[0]).toBe("stub-lender-20200101T000003Z.dump.gpg")
    const fresh = files[1]
    expect(readFileSync(join(lender, "backups", fresh)).includes("PGDMP-stub")).toBe(false) // ciphertext, not the plain dump
    expect(readFileSync(join(lender, "backups", `${fresh}.counts`), "utf8")).toMatch(/Tenant=1/)
    expect(existsSync(join(lender, "backups", "stub-lender-20200101T000001Z.dump.gpg.counts"))).toBe(false)
  })

  it("leaves no partial file when the dump is empty", () => {
    // pg_dump prints nothing and exits 0; pg_restore --list rejects input without the PGDMP header, like the real one.
    writeFileSync(join(root, "bin", "docker"), String.raw`#!/bin/sh
case "$*" in *pg_dump*) exit 0 ;; *"pg_restore --list"*) d="$(cat)"; case "$d" in PGDMP*) exit 0 ;; *) exit 1 ;; esac ;; esac
exit 0
`)
    const r = sh("backup.sh", [lender])
    expect(r.status).not.toBe(0)
    expect(readdirSync(join(lender, "backups"))).toEqual([])
  })
})

describe("restore.sh", () => {
  const backup = () => {
    expect(sh("backup.sh", [lender]).status).toBe(0)
    return join(lender, "backups", readdirSync(join(lender, "backups")).find((f) => f.endsWith(".dump.gpg"))!)
  }

  it("restores into a new scratch database and never renames or drops the live one", () => {
    const f = backup()
    const r = sh("restore.sh", [lender, f], { STUB_COMMIT_NEW: "x" })
    expect(r.status).toBe(0)
    expect(r.calls.some((c) => /CREATE DATABASE "d_restore_\d+"/.test(c))).toBe(true)
    expect(r.calls.some((c) => c.includes("ALTER DATABASE") || /DROP DATABASE[^"]*"d"/.test(c))).toBe(false)
  })

  it("refuses --over-live without --confirm, and with the wrong slug, before creating anything", () => {
    const f = backup()
    for (const extra of [[], ["--confirm", "other-lender"]]) {
      const r = sh("restore.sh", [lender, f, "--over-live", ...extra])
      expect(r.status).not.toBe(0)
      expect(r.out).toMatch(/refusing --over-live/)
      expect(r.calls.some((c) => c.includes("CREATE DATABASE"))).toBe(false)
    }
  })

  it("swaps the databases only with --over-live --confirm <slug>, after a pre-restore backup and with the app stopped", () => {
    const f = backup()
    const r = sh("restore.sh", [lender, f, "--over-live", "--confirm", "stub-lender"])
    expect(r.status).toBe(0)
    const stop = idx(r.calls, "stop app"), alter = idx(r.calls, "ALTER DATABASE")
    expect(stop).toBeGreaterThan(-1)
    expect(alter).toBeGreaterThan(stop)
    expect(readdirSync(join(lender, "backups")).some((x) => x.includes("pre-restore") && x.endsWith(".dump.gpg"))).toBe(true)
  })

  it("works before any deploy: compose is given a placeholder image that cannot be pulled", () => {
    const f = backup()
    const r = sh("restore.sh", [lender, f])
    expect(r.status).toBe(0)
    expect(r.calls.some((c) => c.includes("up -d db") && c.endsWith("APP_IMAGE=credaflow-undeployed:none"))).toBe(true)
  })

  it("fails and drops the scratch database when the counts differ from the sidecar", () => {
    const f = backup()
    writeFileSync(`${f}.counts`, "Tenant=9\n")
    const r = sh("restore.sh", [lender, f])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/differ/)
    expect(r.calls.some((c) => /DROP DATABASE IF EXISTS "d_restore_/.test(c))).toBe(true)
  })

  it("rejects a wrong passphrase", () => {
    const f = backup()
    writeFileSync(join(lender, "secrets/backup.passphrase"), "wrong\n")
    expect(sh("restore.sh", [lender, f]).status).not.toBe(0)
  })
})

describe("docker-compose.lender.yml", () => {
  const compose = spawnSync("sh", ["-c", "docker compose version >/dev/null 2>&1 && echo 'docker compose' || (docker-compose version >/dev/null 2>&1 && echo docker-compose)"], { encoding: "utf8" }).stdout.trim()

  it.skipIf(!compose)("is valid compose that publishes only the app port and pins no container name", () => {
    const dir = mkdtempSync(join(tmpdir(), "lender-compose-"))
    cpSync(join(SRC, "docker-compose.lender.yml"), join(dir, "docker-compose.yml"))
    writeFileSync(join(dir, ".env"), "")
    const env = { ...process.env, APP_IMAGE: "cf:x", APP_PORT: "3999", POSTGRES_USER: "u", POSTGRES_PASSWORD: "p", POSTGRES_DB: "d", NEXTAUTH_SECRET: "s" }
    const [bin, ...sub] = compose.split(" ")
    const r = spawnSync(bin, [...sub, "-p", "x", "-f", join(dir, "docker-compose.yml"), "--project-directory", dir, "config", "--format", "json"], { env, encoding: "utf8" })
    rmSync(dir, { recursive: true, force: true })
    expect(r.status, r.stderr).toBe(0)
    const cfg = JSON.parse(r.stdout) as { services: Record<string, { ports?: { published: string; host_ip: string }[]; container_name?: string }> }
    expect(cfg.services.db.ports).toBeUndefined()
    expect(cfg.services.app.ports).toEqual([expect.objectContaining({ published: "3999", host_ip: "127.0.0.1" })])
    expect(Object.values(cfg.services).some((s) => s.container_name)).toBe(false)
  })
})

describe("provision-lender.sh", () => {
  it("refuses a lender directory inside the git checkout", () => {
    writeFileSync(join(root, "cfg.json"), JSON.stringify({ slug: "stub-lender" }))
    const r = sh("provision-lender.sh", [join(repo, "lender-here"), "--config", join(root, "cfg.json"), "--port", "3999", "--public-url", "http://x"])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/inside the git checkout/)
    expect(existsSync(join(repo, "lender-here"))).toBe(false)
  })
})
