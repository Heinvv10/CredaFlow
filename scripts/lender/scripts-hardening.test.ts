import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { idx, lender, root, sh, state } from "./scripts.test-helpers"

// Regression tests for the second review round: project collision, snapshot-consistent
// counts, drift handling, deploy failure paths, bind, same-tag redeploys, retention
// pools and the shared lock.

const addEnv = (line: string) => writeFileSync(join(lender, ".env"), `${readFileSync(join(lender, ".env"), "utf8")}${line}\n`)
const backup = () => {
  expect(sh("backup.sh", [lender]).status).toBe(0)
  return join(lender, "backups", readdirSync(join(lender, "backups")).find((f) => f.endsWith(".dump.gpg"))!)
}

describe("compose project", () => {
  it("is credaflow-lender-<slug>, clear of the other stacks' credaflow-<word> projects", () => {
    const r = sh("deploy.sh", [lender, "cf:new"])
    expect(r.calls.filter((c) => c.startsWith("compose -p ")).every((c) => c.startsWith("compose -p credaflow-lender-stub-lender "))).toBe(true)
  })
})

describe("snapshot-consistent backup counts", () => {
  it("takes the counts and the dump in one session: pg_dump --snapshot, counts passed in, none taken separately", () => {
    const r = sh("backup.sh", [lender])
    expect(r.status).toBe(0)
    const all = r.calls.join("\n")
    expect(all).toContain("pg_dump -Fc --no-owner --snapshot=")
    expect(all).toContain("pg_export_snapshot()")
    expect(all).toMatch(/COUNTS_SQL=SELECT 'Tenant='/)
    // the old way ran the counts as a separate psql before the dump
    expect(r.calls.some((c) => /psql .*-c SELECT 'Tenant='/.test(c))).toBe(false)
  })

  it("fails (and keeps nothing) when no counts come back from the session", () => {
    writeFileSync(join(root, "bin", "docker"), String.raw`#!/bin/sh
case "$*" in *pg_dump*) printf 'PGDMP-x' ;; *"pg_restore --list"*) d="$(cat)"; case "$d" in PGDMP*) ;; *) exit 1 ;; esac ;; esac
exit 0
`)
    const r = sh("backup.sh", [lender])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/no row counts/)
    expect(readdirSync(join(lender, "backups"))).toEqual([])
  })
})

describe("restore count drift", () => {
  it("is a loud warning naming the table on a scratch restore, never a block; the scratch database is kept", () => {
    const f = backup()
    writeFileSync(`${f}.counts`, "Tenant=1\nUser=9\nmigrations=5\n")
    const r = sh("restore.sh", [lender, f])
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/WARNING: restored row counts DIFFER/)
    expect(r.out).toContain("User: backup=9 restored=1")
    expect(r.out).not.toContain("Tenant: backup")
    expect(r.out).toMatch(/VERIFIED WITH WARNINGS/)
    expect(r.calls.some((c) => /DROP DATABASE IF EXISTS "d_restore_/.test(c))).toBe(false)
  })

  it("--over-live refuses it without --accept-count-drift, before stopping the app, and drops the scratch database", () => {
    const f = backup()
    writeFileSync(`${f}.counts`, "User=9\n")
    const r = sh("restore.sh", [lender, f, "--over-live", "--confirm", "stub-lender"])
    expect(r.status).not.toBe(0)
    expect(r.out).toContain("User: backup=9 restored=1")
    expect(r.out).toMatch(/--accept-count-drift/)
    expect(r.calls.some((c) => c.includes("stop app") || c.includes("ALTER DATABASE"))).toBe(false)
    expect(r.calls.some((c) => /DROP DATABASE IF EXISTS "d_restore_/.test(c))).toBe(true)
  })

  it("--over-live proceeds with --accept-count-drift", () => {
    const f = backup()
    writeFileSync(`${f}.counts`, "User=9\n")
    const r = sh("restore.sh", [lender, f, "--over-live", "--confirm", "stub-lender", "--accept-count-drift"])
    expect(r.status).toBe(0)
    expect(r.calls.some((c) => c.includes("ALTER DATABASE"))).toBe(true)
  })

  it("--accept-count-drift is only valid with --over-live", () => {
    expect(sh("restore.sh", [lender, backup(), "--accept-count-drift"]).status).not.toBe(0)
  })

  it("a failed query in the restored database fails loudly and drops the scratch database", () => {
    const f = backup()
    for (const failing of ["finished_at", 'FROM "Tenant"']) {
      const r = sh("restore.sh", [lender, f], { STUB_FAIL_MATCH: failing })
      expect(r.status, failing).not.toBe(0)
      expect(r.calls.some((c) => /DROP DATABASE IF EXISTS "d_restore_/.test(c)), failing).toBe(true)
    }
  })
})

describe("deploy failure paths", () => {
  it("refuses, before touching anything, when a host port is taken by something else", async () => {
    const server = createServer()
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
    const port = (server.address() as { port: number }).port
    writeFileSync(join(lender, ".env"), readFileSync(join(lender, ".env"), "utf8").replace("APP_PORT=3999", `APP_PORT=${port}`))
    const r = sh("deploy.sh", [lender, "cf:new"])
    server.close()
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(new RegExp(`host port ${port} .* already in use`))
    expect(r.calls.filter((c) => /pg_dump|migrate|up -d|stop/.test(c))).toEqual([])
  })

  it("lets a port through when one of this lender's containers is configured to publish it, whatever its state", async () => {
    const server = createServer()
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
    const port = (server.address() as { port: number }).port
    writeFileSync(join(lender, ".env"), readFileSync(join(lender, ".env"), "utf8").replace("APP_PORT=3999", `APP_PORT=${port}`))
    const r = sh("deploy.sh", [lender, "cf:new"], { STUB_OUR_CONTAINER: "abc123", STUB_PS_PORTS: `${port}` })
    server.close()
    expect(r.status).toBe(0)
  })

  it("counts a listener on its port as foreign when this lender's container is NOT running (stopped stack, port taken by someone else)", async () => {
    const server = createServer()
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok))
    const port = (server.address() as { port: number }).port
    writeFileSync(join(lender, ".env"), readFileSync(join(lender, ".env"), "utf8").replace("APP_PORT=3999", `APP_PORT=${port}`))
    // no running container of ours: the stub answers nothing to the running/restarting filter
    const r = sh("deploy.sh", [lender, "cf:new"], { STUB_OUR_CONTAINER: "" })
    server.close()
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/already in use/)
  })

  it("a failing `compose up` goes through the rollback path and is logged", () => {
    writeFileSync(join(lender, "state/current-image"), "cf:old\n")
    // the new image would be healthy: only `compose up` fails, so only the rollback path can catch it
    const r = sh("deploy.sh", [lender, "cf:new-upfail"])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/ROLLED BACK to cf:old/)
    expect(readFileSync(join(lender, "state/image.env"), "utf8")).toContain("APP_IMAGE=sha256:id-cf_old")
    expect(state("deploys.log")).toMatch(/SWITCH_FAILED[\s\S]*ROLLED_BACK/)
    expect(state("current-image")).toBe("cf:old")
  })

  it("a same-tag redeploy that goes unhealthy is logged and left running, never stopped", () => {
    writeFileSync(join(lender, "state/current-image"), "cf:new\n")
    const r = sh("deploy.sh", [lender, "cf:new", "--health-timeout", "1"], { STUB_HEALTH_STATUS: "error" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/Left running, NOT stopped/)
    expect(r.calls.some((c) => c.includes("stop app"))).toBe(false)
    expect(state("deploys.log")).toMatch(/SAME_TAG_UNHEALTHY/)
  })

  it("an unhealthy first deploy over an already-serving stack is left running, not stopped", () => {
    const r = sh("deploy.sh", [lender, "cf:new", "--health-timeout", "1"], { STUB_HEALTH_STATUS: "error", STUB_SERVING: "abc123" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/left running, NOT stopped/)
    expect(r.calls.some((c) => c.includes("stop app"))).toBe(false)
  })
})

describe("bind address", () => {
  it("probes loopback for a wildcard bind and the bound address for a specific one", () => {
    addEnv("APP_BIND=0.0.0.0")
    expect(sh("deploy.sh", [lender, "cf:new"]).calls.some((c) => c.startsWith("curl") && c.includes("http://127.0.0.1:3999/api/health"))).toBe(true)
    writeFileSync(join(lender, ".env"), readFileSync(join(lender, ".env"), "utf8").replace("APP_BIND=0.0.0.0", "APP_BIND=127.0.0.2"))
    const r = sh("deploy.sh", [lender, "cf:new"])
    expect(r.status).toBe(0)
    expect(r.calls.some((c) => c.startsWith("curl") && c.includes("http://127.0.0.2:3999/api/health"))).toBe(true)
    expect(r.calls.some((c) => c.startsWith("curl") && c.includes("http://127.0.0.2:3998/api/health"))).toBe(true)
  })
})

describe("one lock per lender", () => {
  it("deploy, backup and restore each wait on it and give up with a clear message", { timeout: 30000 }, async () => {
    const f = backup()
    await holdThen(async () => {
      for (const [script, args] of [["deploy.sh", [lender, "cf:new"]], ["backup.sh", [lender]], ["restore.sh", [lender, f]]] as const) {
        const r = sh(script, [...args], { LENDER_LOCK_WAIT: "1" })
        expect(r.status, script).not.toBe(0)
        expect(r.out, script).toMatch(/holds .*lender\.lock/)
      }
    })
    expect(sh("backup.sh", [lender], { LENDER_LOCK_WAIT: "1" }).status).toBe(0)
  })

  it("deploy's own pre-migration backup does not deadlock on its parent's lock", () => {
    expect(sh("deploy.sh", [lender, "cf:new"], { LENDER_LOCK_WAIT: "1" }).status).toBe(0)
    expect(existsSync(join(lender, "state/lender.lock"))).toBe(true)
    expect(idx(readFileSync(join(root, "docker.log"), "utf8").split("\n"), "pg_dump")).toBeGreaterThan(-1)
  })
})

describe("restore --over-live without a counts sidecar", () => {
  it("needs --accept-count-drift, like any other unconfirmed counts", () => {
    const f = backup()
    rmSync(`${f}.counts`)
    const refused = sh("restore.sh", [lender, f, "--over-live", "--confirm", "stub-lender"])
    expect(refused.status).not.toBe(0)
    expect(refused.out).toMatch(/no sidecar/)
    expect(refused.out).toMatch(/--accept-count-drift/)
    expect(refused.calls.some((c) => c.includes("stop app") || c.includes("ALTER DATABASE"))).toBe(false)
    const accepted = sh("restore.sh", [lender, f, "--over-live", "--confirm", "stub-lender", "--accept-count-drift"])
    expect(accepted.status).toBe(0)
  })

  it("a scratch restore without a sidecar still verifies, with a warning", () => {
    const f = backup()
    rmSync(`${f}.counts`)
    const r = sh("restore.sh", [lender, f])
    expect(r.status).toBe(0)
    expect(r.out).toMatch(/VERIFIED WITH WARNINGS/)
  })
})

describe("locks", () => {
  it("a lender dir reached through a symlink and its target are one lock: provision does not deadlock on itself", { timeout: 30000 }, () => {
    const link = join(root, "link-to-lender")
    symlinkSync(lender, link)
    const r = sh("backup.sh", [link], { LENDER_LOCK_WAIT: "3" })
    expect(r.status, r.out).toBe(0)
    // every compose call names the CANONICAL directory (that is what the container's working_dir label records)
    expect(r.calls.filter((c) => c.startsWith("compose -p ")).every((c) => c.includes(`--project-directory ${realpathSync(lender)} `))).toBe(true)
    // and the two spellings exclude each other
    return holdThen(async () => {
      const blocked = sh("backup.sh", [link], { LENDER_LOCK_WAIT: "1" })
      expect(blocked.status).not.toBe(0)
      expect(blocked.out).toMatch(/holds .*lender\.lock/)
    })
  })

  it("LENDER_LOCK_HELD in the environment is not a pass: only the real inherited descriptor is", { timeout: 30000 }, async () => {
    await holdThen(async () => {
      const r = sh("backup.sh", [lender], { LENDER_LOCK_WAIT: "1", LENDER_LOCK_HELD: lender })
      expect(r.status).not.toBe(0)
      expect(r.out).toMatch(/holds .*lender\.lock/)
    })
  })

  it("two lender dirs that would use the same compose project exclude each other (host-wide project lock)", { timeout: 30000 }, async () => {
    const other = join(root, "other-dir")
    mkdirSync(join(other, "state"), { recursive: true })
    for (const f of [".env", "secrets/auth.env", "secrets/backup.passphrase"]) {
      mkdirSync(join(other, f, ".."), { recursive: true })
      writeFileSync(join(other, f), readFileSync(join(lender, f)))
    }
    const base = join(root, "run", `credaflow-lender-locks-${process.getuid?.()}`)
    mkdirSync(base, { recursive: true, mode: 0o700 })
    await holdThen(async () => {
      const r = sh("backup.sh", [other], { LENDER_LOCK_WAIT: "1" })
      expect(r.status).not.toBe(0)
      expect(r.out).toMatch(/compose project 'credaflow-lender-stub-lender' holds/)
    }, join(base, "credaflow-lender-stub-lender.lock"))
  })
})

// Runs fn while another process holds FILE's lock, from the moment flock has it
// (the holder says so on stdout) until fn settles, however long fn takes on a
// loaded host. No sleep decides either end: a fixed-length hold could expire
// before the last script under test reached its own flock.
async function holdThen(fn: () => Promise<void>, file = join(lender, "state/lender.lock")) {
  const holder = spawn("bash", ["-c", 'exec 9>>"$1" && flock -x 9 && echo locked && exec sleep 600', "hold", file], { stdio: ["ignore", "pipe", "ignore"] })
  const exited = new Promise((r) => holder.once("exit", r))
  await new Promise<void>((ok, fail) => {
    holder.stdout.on("data", (d: Buffer) => { if (d.toString().includes("locked")) ok() })
    void exited.then(() => fail(new Error(`the lock holder exited before it took ${file}`)))
  })
  try {
    await fn()
  } finally {
    holder.kill()
    await exited
  }
}
