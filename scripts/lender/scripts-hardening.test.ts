import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
const dumps = () => readdirSync(join(lender, "backups")).filter((f) => f.endsWith(".dump.gpg")).sort()

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

describe("backup retention pools", () => {
  it("keeps the newest N of the pre-* pool and of the rest separately", () => {
    const names = [
      ...["01", "02", "03", "04"].map((n) => `stub-lender-202001${n}T000000Z`),
      ...["01", "02", "03", "04"].map((n) => `stub-lender-202002${n}T000000Z-pre-v${n}`),
    ]
    for (const n of names) writeFileSync(join(lender, "backups", `${n}.dump.gpg`), "old")
    const r = sh("backup.sh", [lender, "--keep", "2", "--label", "pre-new"])
    expect(r.status).toBe(0)
    const pre = dumps().filter((f) => f.includes("-pre-"))
    const rest = dumps().filter((f) => !f.includes("-pre-"))
    expect(pre).toHaveLength(2) // the fresh pre-new and the newest old one
    expect(pre.some((f) => f.includes("pre-new"))).toBe(true)
    expect(pre.some((f) => f.includes("202002") && f.includes("-pre-v04"))).toBe(true)
    expect(rest).toEqual(["stub-lender-20200103T000000Z.dump.gpg", "stub-lender-20200104T000000Z.dump.gpg"])
  })

  it("is NUL-safe: a filename with a newline is neither listed as two paths nor lets rm reach another file", () => {
    const victim = join(root, "stub-lender-victim.dump.gpg") // what the second "line" of the odd name would point at, relative to the cwd
    writeFileSync(victim, "keep me")
    const odd = "stub-lender-20200101T000009Z-pre-a\nstub-lender-victim.dump.gpg"
    writeFileSync(join(lender, "backups", odd), "odd")
    for (const n of ["01", "02", "03"]) writeFileSync(join(lender, "backups", `stub-lender-202001${n}T000000Z.dump.gpg`), "old")
    expect(sh("backup.sh", [lender, "--keep", "1"]).status).toBe(0)
    expect(existsSync(victim)).toBe(true)
    expect(existsSync(join(lender, "backups", odd))).toBe(true) // not ours: never touched
    expect(dumps().filter((f) => !f.includes("\n"))).toHaveLength(1) // the nightly pool still pruned to --keep
  })

  it("a run of nightly backups never removes pre-migration ones", () => {
    for (const n of ["01", "02", "03"]) writeFileSync(join(lender, "backups", `stub-lender-202002${n}T000000Z-pre-v${n}.dump.gpg`), "old")
    expect(sh("backup.sh", [lender, "--keep", "3"]).status).toBe(0)
    expect(dumps().filter((f) => f.includes("-pre-"))).toHaveLength(3)
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
  const holdLock = async (seconds: number) => {
    const child = spawn("flock", ["-x", join(lender, "state/lender.lock"), "sleep", String(seconds)], { stdio: "ignore" })
    await new Promise((r) => setTimeout(r, 400))
    return child
  }

  it("deploy, backup and restore each wait on it and give up with a clear message", { timeout: 30000 }, async () => {
    const f = backup()
    const holder = await holdLock(4)
    try {
      for (const [script, args] of [["deploy.sh", [lender, "cf:new"]], ["backup.sh", [lender]], ["restore.sh", [lender, f]]] as const) {
        const r = sh(script, [...args], { LENDER_LOCK_WAIT: "1" })
        expect(r.status, script).not.toBe(0)
        expect(r.out, script).toMatch(/holds .*lender\.lock/)
      }
    } finally {
      await new Promise((r) => holder.on("exit", r))
    }
    expect(sh("backup.sh", [lender], { LENDER_LOCK_WAIT: "1" }).status).toBe(0)
  })

  it("deploy's own pre-migration backup does not deadlock on its parent's lock", () => {
    expect(sh("deploy.sh", [lender, "cf:new"], { LENDER_LOCK_WAIT: "1" }).status).toBe(0)
    expect(existsSync(join(lender, "state/lender.lock"))).toBe(true)
    expect(idx(readFileSync(join(root, "docker.log"), "utf8").split("\n"), "pg_dump")).toBeGreaterThan(-1)
  })
})

describe("failed migration recovery does not poison later backups", () => {
  it("restore counts a migration resolved with --rolled-back as finished (rolled_back_at set, finished_at NULL)", () => {
    const f = backup()
    const r = sh("restore.sh", [lender, f])
    expect(r.status).toBe(0)
    const q = r.calls.find((c) => c.includes("FROM _prisma_migrations") && c.includes("FILTER"))!
    expect(q).toContain("finished_at IS NULL AND rolled_back_at IS NULL")
  })

  it("backup refuses a dump taken while a migration is unfinished, names it, and keeps nothing", () => {
    const r = sh("backup.sh", [lender], { STUB_MIG_UNFINISHED: "20261012090000_loan_product_amount_bounds" })
    expect(r.status).not.toBe(0)
    expect(r.out).toContain("20261012090000_loan_product_amount_bounds")
    expect(r.out).toMatch(/restore\.sh would reject it/)
    expect(readdirSync(join(lender, "backups"))).toEqual([])
  })

  it("the snapshot session runs the same unfinished-migration predicate restore uses", () => {
    const r = sh("backup.sh", [lender])
    expect(r.status).toBe(0)
    expect(r.calls.join("\n")).toContain("MIG_UNFINISHED_WHERE=finished_at IS NULL AND rolled_back_at IS NULL")
  })

  it("deploy after a failed-then-resolved migration: its pre-migration backup is taken and restorable", () => {
    // the exact sequence at script level: migrate fails (deploy stops, app not switched) ...
    const failed = sh("deploy.sh", [lender, "cf:new"], { STUB_MIGRATE_RC: "1" })
    expect(failed.status).not.toBe(0)
    expect(failed.out).toMatch(/A failed migration/)
    // ... prisma.sh migrate resolve --rolled-back ...
    writeFileSync(join(lender, "state/current-image"), "cf:old\n")
    expect(sh("prisma.sh", [lender, "migrate", "resolve", "--rolled-back", "20261012090000_loan_product_amount_bounds"]).status).toBe(0)
    // ... redeploy, then a backup, then a restore of it
    expect(sh("deploy.sh", [lender, "cf:new"]).status).toBe(0)
    const f = backup()
    expect(sh("restore.sh", [lender, f]).status).toBe(0)
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
  it("a lender dir reached through a symlink and its target are one lock: provision does not deadlock on itself", () => {
    const link = join(root, "link-to-lender")
    symlinkSync(lender, link)
    const r = sh("backup.sh", [link], { LENDER_LOCK_WAIT: "3" })
    expect(r.status, r.out).toBe(0)
    // and the two spellings exclude each other
    return holdThen(async () => {
      const blocked = sh("backup.sh", [link], { LENDER_LOCK_WAIT: "1" })
      expect(blocked.status).not.toBe(0)
      expect(blocked.out).toMatch(/holds .*lender\.lock/)
    })
  })

  it("LENDER_LOCK_HELD in the environment is not a pass: only the real inherited descriptor is", async () => {
    await holdThen(async () => {
      const r = sh("backup.sh", [lender], { LENDER_LOCK_WAIT: "1", LENDER_LOCK_HELD: lender })
      expect(r.status).not.toBe(0)
      expect(r.out).toMatch(/holds .*lender\.lock/)
    })
  })

  it("two lender dirs that would use the same compose project exclude each other (host-wide project lock)", async () => {
    const other = join(root, "other-dir")
    mkdirSync(join(other, "state"), { recursive: true })
    for (const f of [".env", "secrets/auth.env", "secrets/backup.passphrase"]) {
      mkdirSync(join(other, f, ".."), { recursive: true })
      writeFileSync(join(other, f), readFileSync(join(lender, f)))
    }
    const base = join(root, "run", `credaflow-lender-locks-${process.getuid?.()}`)
    mkdirSync(base, { recursive: true, mode: 0o700 })
    const child = spawn("flock", ["-x", join(base, "credaflow-lender-stub-lender.lock"), "sleep", "4"], { stdio: "ignore" })
    await new Promise((r) => setTimeout(r, 400))
    try {
      const r = sh("backup.sh", [other], { LENDER_LOCK_WAIT: "1" })
      expect(r.status).not.toBe(0)
      expect(r.out).toMatch(/compose project 'credaflow-lender-stub-lender' holds/)
    } finally {
      await new Promise((r) => child.on("exit", r))
    }
  })
})

async function holdThen(fn: () => Promise<void>) {
  const child = spawn("flock", ["-x", join(lender, "state/lender.lock"), "sleep", "4"], { stdio: "ignore" })
  await new Promise((r) => setTimeout(r, 400))
  try {
    await fn()
  } finally {
    await new Promise((r) => child.on("exit", r))
  }
}
