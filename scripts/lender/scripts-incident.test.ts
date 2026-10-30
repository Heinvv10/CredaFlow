import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { lender, root, sh } from "./scripts.test-helpers"

// A failed migration is an incident: backups must keep flowing (marked, never silently
// skipped), restore must not treat such a dump as a clean restore point, and the documented
// recovery (migrate resolve --rolled-back) must leave later backups restorable.

const backup = () => {
  expect(sh("backup.sh", [lender]).status).toBe(0)
  return join(lender, "backups", readdirSync(join(lender, "backups")).find((f) => f.endsWith(".dump.gpg"))!)
}
const dumps = () => readdirSync(join(lender, "backups")).filter((f) => f.endsWith(".dump.gpg")).sort()

describe("failed migration recovery does not poison later backups", () => {
  it("restore counts a migration resolved with --rolled-back as finished (rolled_back_at set, finished_at NULL)", () => {
    const f = backup()
    const r = sh("restore.sh", [lender, f])
    expect(r.status).toBe(0)
    const q = r.calls.find((c) => c.includes("FROM _prisma_migrations") && c.includes("FILTER"))!
    expect(q).toContain("finished_at IS NULL AND rolled_back_at IS NULL")
  })

  it("a restore replays no ownership or grants (pg_restore --no-owner --no-acl) and then re-asserts the audit protections and the application's login, in the restored database, before anything is swapped", () => {
    const f = backup()
    const r = sh("restore.sh", [lender, f])
    expect(r.status, r.out).toBe(0)
    const restore = r.calls.findIndex((c) => c.includes("pg_restore") && c.includes("--exit-on-error"))
    const reassert = r.calls.findIndex((c) => c.includes("audit_reassert_protections"))
    const role = r.calls.findIndex((c) => /psql -v ON_ERROR_STOP=1 -q -U u -d \S*restore_\S* -f -/.test(c))
    expect(r.calls[restore]).toContain("--no-owner --no-acl")
    expect(reassert).toBeGreaterThan(restore)
    expect(role).toBeGreaterThan(reassert)
    expect(r.calls[reassert]).toContain("restore_") // the scratch database, not the live one
  })

  const UNRESOLVED = "20261012090000_loan_product_amount_bounds"
  const unresolvedBackup = () => {
    const r = sh("backup.sh", [lender], { STUB_MIG_UNFINISHED: UNRESOLVED })
    expect(r.status, r.out).toBe(0)
    const f = readdirSync(join(lender, "backups")).find((x) => x.endsWith(".dump.gpg"))!
    return { r, f: join(lender, "backups", f) }
  }

  it("backup STILL writes the dump during the incident, under a distinct name, with a loud warning", () => {
    const { r, f } = unresolvedBackup()
    expect(f).toMatch(/stub-lender-\d{8}T\d{6}Z-unresolved\.dump\.gpg$/)
    expect(readFileSync(`${f}.unresolved`, "utf8").trim()).toBe(UNRESOLVED)
    expect(existsSync(`${f}.counts`)).toBe(true)
    expect(r.out).toMatch(/WARNING: this backup was taken while migration\(s\) are FAILED AND UNRESOLVED/)
    expect(r.out).toContain(UNRESOLVED)
    expect(r.out).toContain("--allow-unresolved-migration")
    expect(readdirSync(join(lender, "backups")).filter((x) => x.endsWith(".partial"))).toEqual([])
  })

  it("restore refuses such a file unless --allow-unresolved-migration, before touching the database", () => {
    const { f } = unresolvedBackup()
    const refused = sh("restore.sh", [lender, f])
    expect(refused.status).not.toBe(0)
    expect(refused.out).toMatch(/failed and unresolved/)
    expect(refused.out).toContain(UNRESOLVED)
    expect(refused.calls.some((c) => c.includes("CREATE DATABASE"))).toBe(false)
    // the marker is the sidecar too: a renamed file is still caught
    const renamed = join(lender, "backups", "stub-lender-20200101T000000Z.dump.gpg")
    writeFileSync(renamed, readFileSync(f)); writeFileSync(`${renamed}.unresolved`, UNRESOLVED); writeFileSync(`${renamed}.counts`, readFileSync(`${f}.counts`))
    expect(sh("restore.sh", [lender, renamed]).status).not.toBe(0)
    const allowed = sh("restore.sh", [lender, f, "--allow-unresolved-migration"], { STUB_MIG_STATE: "1 5" })
    expect(allowed.status, allowed.out).toBe(0)
    expect(allowed.out).toMatch(/WARNING: --allow-unresolved-migration: 1 migration\(s\)/)
  })

  it("a normal restore of a dump with an unfinished migration still fails (the flag is what allows it)", () => {
    const f = backup()
    const r = sh("restore.sh", [lender, f], { STUB_MIG_STATE: "1 5" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/migration table check failed/)
  })

  it("--allow-unresolved-migration still needs a migration table", () => {
    const { f } = unresolvedBackup()
    expect(sh("restore.sh", [lender, f, "--allow-unresolved-migration"], { STUB_MIG_STATE: "0 0" }).status).not.toBe(0)
  })

  it("unresolved dumps are their own retention pool: neither evicting nor evicted by the clean nightlies", () => {
    for (const n of ["01", "02", "03"]) {
      writeFileSync(join(lender, "backups", `stub-lender-202003${n}T000000Z.dump.gpg`), "clean")
      writeFileSync(join(lender, "backups", `stub-lender-202004${n}T000000Z-unresolved.dump.gpg`), "inc")
      writeFileSync(join(lender, "backups", `stub-lender-202004${n}T000000Z-unresolved.dump.gpg.unresolved`), "x")
    }
    expect(sh("backup.sh", [lender, "--keep", "2"], { STUB_MIG_UNFINISHED: UNRESOLVED }).status).toBe(0)
    const all = dumps()
    expect(all.filter((x) => x.includes("-unresolved"))).toHaveLength(2) // 3 old + the new one, pruned to 2
    expect(all.filter((x) => !x.includes("-unresolved"))).toHaveLength(2) // the clean pool pruned on its own: 3 -> 2
    expect(existsSync(join(lender, "backups", "stub-lender-20200401T000000Z-unresolved.dump.gpg.unresolved"))).toBe(false) // sidecar goes with its dump
  })

  it("the snapshot session runs the same unfinished-migration predicate restore uses", () => {
    const r = sh("backup.sh", [lender])
    expect(r.status).toBe(0)
    const all = r.calls.join("\n")
    expect(all).toContain("MIG_UNFINISHED_WHERE=finished_at IS NULL AND rolled_back_at IS NULL")
    // ...and the in-container script uses that variable, not a predicate of its own
    expect(all).toMatch(/FROM _prisma_migrations WHERE %s;\s*" "\$MIG_UNFINISHED_WHERE" >&3/) // (the stub's echo expands the \n)
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
