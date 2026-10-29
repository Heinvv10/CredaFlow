import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { idx, lender, log, repo, root, sh, state } from "./scripts.test-helpers"

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

  it("sets up the application's database login after migrating and before switching, as the owner", () => {
    const r = sh("deploy.sh", [lender, "cf:new"])
    expect(r.status).toBe(0)
    const migrate = idx(r.calls, "migrate deploy"), role = idx(r.calls, "psql -v ON_ERROR_STOP=1 -q -U u -d d -f -"), up = idx(r.calls, "up -d --no-deps app")
    expect(role).toBeGreaterThan(migrate)
    expect(up).toBeGreaterThan(role)
    expect(r.calls.join("\n")).not.toContain("appp") // the application's password is never on a command line
  })

  it("does not switch the app when its database login cannot be set up", () => {
    writeFileSync(join(lender, "state/current-image"), "cf:old\n")
    const r = sh("deploy.sh", [lender, "cf:new"], { STUB_FAIL_MATCH: "psql -v ON_ERROR_STOP=1 -q -U u" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/application's database login/)
    expect(r.calls.some((c) => c.includes("up -d --no-deps app"))).toBe(false)
    expect(state("current-image")).toBe("cf:old")
  })

  it("refuses to deploy without a 32+ character AUDIT_CHAIN_KEY, before anything changes", () => {
    const env = readFileSync(join(lender, ".env"), "utf8").replace(/AUDIT_CHAIN_KEY=.*\n/, "AUDIT_CHAIN_KEY=short\n")
    writeFileSync(join(lender, ".env"), env)
    const r = sh("deploy.sh", [lender, "cf:new"])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/AUDIT_CHAIN_KEY/)
    expect(r.calls.some((c) => c.includes("migrate deploy") || c.includes("pg_dump"))).toBe(false)
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
    expect(readFileSync(join(lender, "state/image.env"), "utf8")).toContain("APP_IMAGE=sha256:id-cf_old")
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

  it("probes the staff and the portal host", () => {
    const r = sh("deploy.sh", [lender, "cf:new"])
    expect(r.calls.some((c) => c.startsWith("curl") && c.includes("127.0.0.1:3999/api/health"))).toBe(true)
    expect(r.calls.some((c) => c.startsWith("curl") && c.includes("127.0.0.1:3998/api/health"))).toBe(true)
    expect(r.calls.find((c) => c.includes("up -d --no-deps app"))).toContain("app-portal")
  })

  describe("refuses to start without distinct per-host auth secrets, before touching anything", () => {
    const cases: [string, (env: string) => void, RegExp][] = [
      ["equal", () => writeFileSync(join(lender, "secrets/auth.env"), `STAFF_AUTH_SECRET=${"x".repeat(40)}\nPORTAL_AUTH_SECRET=${"x".repeat(40)}\n`), /render EQUAL/],
      ["portal unset", () => writeFileSync(join(lender, "secrets/auth.env"), `STAFF_AUTH_SECRET=${"s".repeat(40)}\n`), /renders empty/],
      ["file missing", () => rmSync(join(lender, "secrets/auth.env")), /renders empty/],
      ["too short", () => writeFileSync(join(lender, "secrets/auth.env"), "STAFF_AUTH_SECRET=a\nPORTAL_AUTH_SECRET=b\n"), /at least 32/],
      ["staff equals shared NEXTAUTH_SECRET", () => writeFileSync(join(lender, "secrets/auth.env"), `STAFF_AUTH_SECRET=shared-secret-0123456789abcdef0123456789\nPORTAL_AUTH_SECRET=${"p".repeat(40)}\n`), /equal to the shared NEXTAUTH_SECRET/],
      ["secret leaked into .env", () => writeFileSync(join(lender, ".env"), `${readFileSync(join(lender, ".env"), "utf8")}STAFF_AUTH_SECRET=${"s".repeat(40)}\n`), /reaches a container's environment/],
    ]
    for (const [name, arrange, msg] of cases) {
      it(name, () => {
        arrange("")
        const r = sh("deploy.sh", [lender, "cf:new"])
        expect(r.status).not.toBe(0)
        expect(r.out).toMatch(msg)
        expect(r.out).not.toContain("xxxxxxxx")
        expect(r.calls.filter((c) => /pg_dump|migrate|up -d|stop/.test(c))).toEqual([])
        expect(state("current-image")).toBeNull()
      })
    }
  })

  it("stops the app when the very first deploy is unhealthy", () => {
    const r = sh("deploy.sh", [lender, "cf:bad", "--health-timeout", "1"])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/first deploy failed; app stopped/)
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

  it("rejects a wrong passphrase", () => {
    const f = backup()
    writeFileSync(join(lender, "secrets/backup.passphrase"), "wrong\n")
    expect(sh("restore.sh", [lender, f]).status).not.toBe(0)
  })
})
