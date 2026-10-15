import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { idx, lender, sh } from "./scripts.test-helpers"

// The uploads volume (ClientDocument files) is part of every backup and every
// restore. The docker stub tars two synthetic files for `tar -cf - -C /u .`
// and answers the in-volume restore script with its file count.

const VOLUME = "credaflow-lender-stub-lender_uploads"
const backups = () => readdirSync(join(lender, "backups"))
const backup = (env: Record<string, string> = {}) => {
  const r = sh("backup.sh", [lender], env)
  expect(r.status, r.out).toBe(0)
  return { r, f: join(lender, "backups", backups().find((f) => f.endsWith(".dump.gpg"))!) }
}

describe("backup.sh and the uploads volume", () => {
  it("tars the volume read-only, encrypts it beside the dump and records the file count", () => {
    const { r, f } = backup()
    const tar = r.calls.find((c) => c.includes("tar -cf - -C /u ."))!
    expect(tar).toContain(`-v ${VOLUME}:/u:ro`)
    expect(idx(r.calls, "pg_dump")).toBeLessThan(idx(r.calls, "tar -cf"))
    const archive = readFileSync(`${f}.uploads.tar.gpg`)
    expect(archive.length).toBeGreaterThan(0)
    expect(archive.includes("synthetic")).toBe(false)
    expect(readFileSync(`${f}.files`, "utf8")).toBe("files=2\n")
    expect(r.out).toMatch(/uploads: 2 file\(s\)/)
    expect(backups().some((x) => x.endsWith(".partial"))).toBe(false)
  })

  it("records files=none, and writes no archive, before the volume exists", () => {
    const { f, r } = backup({ STUB_NO_UPLOADS: "1" })
    expect(readFileSync(`${f}.files`, "utf8")).toBe("files=none\n")
    expect(existsSync(`${f}.uploads.tar.gpg`)).toBe(false)
    expect(r.out).toMatch(/no uploads volume/)
  })

  it("fails, leaving nothing behind, when the uploads tar is unreadable", () => {
    const r = sh("backup.sh", [lender], { STUB_FAIL_MATCH: "tar -cf" })
    expect(r.status).not.toBe(0)
    expect(backups()).toEqual([])
  })

  it("retention removes a pruned backup's uploads archive and file count with it", () => {
    for (const d of ["20200101T000001Z", "20200101T000002Z"]) {
      for (const ext of [".dump.gpg", ".dump.gpg.counts", ".dump.gpg.uploads.tar.gpg", ".dump.gpg.files"]) {
        writeFileSync(join(lender, "backups", `stub-lender-${d}${ext}`), "old")
      }
    }
    expect(sh("backup.sh", [lender, "--keep", "1"]).status).toBe(0)
    expect(backups().filter((x) => x.startsWith("stub-lender-2020"))).toEqual([])
  })
})

// The drill's checks run against real docker (exercised by hand: docs/DEPLOY.md);
// these pin that it refuses what it cannot verify, before creating anything.
describe("restore-drill.sh refusals", () => {
  it("refuses with no backup, a backup without counts, or nothing deployed", () => {
    let r = sh("restore-drill.sh", [lender])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/no backup/)
    const { f } = backup()
    rmSync(`${f}.counts`)
    r = sh("restore-drill.sh", [lender, f])
    expect(r.out).toMatch(/no \.counts sidecar/)
    writeFileSync(`${f}.counts`, "Tenant=1\n")
    r = sh("restore-drill.sh", [lender, f])
    expect(r.out).toMatch(/nothing deployed yet/)
    expect(r.calls.some((c) => c.includes("credaflow-drill-"))).toBe(false)
  })
})

describe("restore.sh and the uploads volume", () => {
  it("verifies the archive against its recorded count on a scratch restore", () => {
    const { f } = backup()
    const r = sh("restore.sh", [lender, f])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/uploads archive holds 2 file\(s\), as recorded/)
    expect(r.out).toMatch(/VERIFIED;/)
    expect(r.calls.some((c) => c.includes("/u/.restore-"))).toBe(false)
  })

  it("warns on a count that differs, and refuses it over live without --accept-count-drift", () => {
    const { f } = backup()
    writeFileSync(`${f}.files`, "files=3\n")
    const scratch = sh("restore.sh", [lender, f])
    expect(scratch.status).toBe(0)
    expect(scratch.out).toMatch(/uploads archive holds 2 file\(s\); the backup recorded 3/)
    const live = sh("restore.sh", [lender, f, "--over-live", "--confirm", "stub-lender"])
    expect(live.status).not.toBe(0)
    expect(live.out).toMatch(/refusing --over-live/)
    expect(live.calls.some((c) => c.includes("ALTER DATABASE"))).toBe(false)
  })

  it("refuses a backup whose recorded archive is missing", () => {
    const { f } = backup()
    rmSync(`${f}.uploads.tar.gpg`)
    const r = sh("restore.sh", [lender, f])
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/uploads\.tar\.gpg is missing/)
  })

  it("over live: restores the files with the app stopped, before the database swap", () => {
    const { f } = backup()
    const r = sh("restore.sh", [lender, f, "--over-live", "--confirm", "stub-lender"])
    expect(r.status, r.out).toBe(0)
    const stop = idx(r.calls, "stop app"), files = idx(r.calls, "/u/.restore-"), alter = idx(r.calls, "ALTER DATABASE")
    expect(stop).toBeGreaterThan(-1)
    expect(files).toBeGreaterThan(stop)
    expect(alter).toBeGreaterThan(files)
    // The logged call spans lines (the script is inline): its first line names the volume.
    expect(r.calls.some((c) => c.includes(`-e EXPECT=2 -v ${VOLUME}:/u `))).toBe(true)
    expect(r.out).toMatch(/uploads restored \(2 file\(s\)\)/)
  })

  it("over live: a failed file restore leaves the database alone and starts the app again", () => {
    const { f } = backup()
    const r = sh("restore.sh", [lender, f, "--over-live", "--confirm", "stub-lender"], { STUB_UPLOADS_RESTORE_FAIL: "1" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/uploads could not be restored/)
    expect(r.calls.some((c) => c.includes("ALTER DATABASE"))).toBe(false)
    expect(idx(r.calls, "up -d --no-deps app app-portal")).toBeGreaterThan(idx(r.calls, "/u/.restore-"))
  })
})
