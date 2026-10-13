import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { git, lender, log, repo, sh, state } from "./scripts.test-helpers"

// Image provenance: what goes into the build context, which lender an image is for,
// which exact image is switched to and rolled back to, and what counts as healthy.


describe("build context", () => {
  it("is a git archive of HEAD in a temp dir: tracked files only, never the working tree", () => {
    writeFileSync(join(repo, ".gitignore"), ".env*\n*.pem\nuploads/\nlib/ocr/accuracy/corpus/\n")
    writeFileSync(join(repo, "tracked.txt"), "t")
    git("add", ".gitignore", "tracked.txt")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "more")
    // ignored files that a `COPY . .` of the working tree would ship
    mkdirSync(join(repo, "uploads"), { recursive: true })
    mkdirSync(join(repo, "lib/ocr/accuracy/corpus"), { recursive: true })
    for (const f of [".env.production", "canary.pem", "uploads/payslip.pdf", "lib/ocr/accuracy/corpus/real-client.pdf"]) writeFileSync(join(repo, f), "SECRET")

    const r = sh("deploy.sh", [lender, "cf:new", "--build"])
    expect(r.status, r.out).toBe(0)
    const builds = readFileSync(`${log}.build`, "utf8").split("\n")
    const listing = builds.join("\n")
    expect(listing).toContain("tracked.txt")
    expect(listing).toContain("scripts/lender/deploy.sh")
    for (const secret of [".env.production", "canary.pem", "payslip.pdf", "real-client.pdf"]) expect(listing).not.toContain(secret)
    const args = builds.filter((l) => l.startsWith("ARGS:"))
    expect(args).toHaveLength(2)
    for (const a of args) {
      expect(a).toContain("--label io.credaflow.lender-slug=stub-lender")
      expect(a).not.toContain(` ${repo}`) // the context is a temp export, not the checkout
    }
  })
})

describe("image provenance", () => {
  it.each(["other-lender", "NONE"])("refuses an image built for %s (or unlabelled), before any database work", (slug) => {
    const r = sh("deploy.sh", [lender, "cf:new"], { STUB_IMAGE_SLUG: slug })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/was built for lender/)
    expect(r.calls.filter((c) => /pg_dump|migrate|up -d|stop/.test(c))).toEqual([])
  })

  it("switches to, and records, immutable image ids", () => {
    const r = sh("deploy.sh", [lender, "cf:new"])
    expect(r.status).toBe(0)
    expect(readFileSync(join(lender, "state/image.env"), "utf8")).toContain("APP_IMAGE=sha256:id-cf_new")
    expect(state("current-image")).toBe("cf:new")
    expect(state("current-image-id")).toBe("sha256:id-cf_new")
    expect(state("current-tools-id")).toBe("sha256:id-cf-tools_new")
  })

  it("rolls back to the previous ID even when its tag now names a different image", () => {
    // cf:new is recorded as running sha256:id-previous; the tag has since been re-pushed
    writeFileSync(join(lender, "state/current-image"), "cf:new\n")
    writeFileSync(join(lender, "state/current-image-id"), "sha256:id-previous\n")
    const r = sh("deploy.sh", [lender, "cf:new", "--health-timeout", "1"], { STUB_HEALTH_STATUS: "error" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/ROLLED BACK to cf:new/)
    expect(readFileSync(join(lender, "state/image.env"), "utf8")).toContain("APP_IMAGE=sha256:id-previous")
    expect(state("current-image-id")).toBe("sha256:id-previous")
  })

  it("does not call a redeploy of the very same image id a rollback target", () => {
    writeFileSync(join(lender, "state/current-image"), "cf:new\n")
    writeFileSync(join(lender, "state/current-image-id"), "sha256:id-cf_new\n")
    const r = sh("deploy.sh", [lender, "cf:new", "--health-timeout", "1"], { STUB_HEALTH_STATUS: "error" })
    expect(r.out).toMatch(/Left running, NOT stopped/)
  })
})

describe("health also needs a tenant-resolving page", () => {
  it("probes /login on the staff host and /portal/login on the portal host", () => {
    const r = sh("deploy.sh", [lender, "cf:new"])
    expect(r.calls.some((c) => c.startsWith("curl") && c.includes("127.0.0.1:3999/login"))).toBe(true)
    expect(r.calls.some((c) => c.startsWith("curl") && c.includes("127.0.0.1:3998/portal/login"))).toBe(true)
  })

  it("treats a 500 page behind a healthy /api/health as a failed switch and rolls back", () => {
    writeFileSync(join(lender, "state/current-image"), "cf:old\n")
    const r = sh("deploy.sh", [lender, "cf:new", "--health-timeout", "1"], { STUB_PAGE_CODE: "500" })
    expect(r.status).not.toBe(0)
    expect(r.out).toMatch(/failed|ROLLED BACK|unhealthy/i)
    expect(state("deploys.log")).toMatch(/SWITCH_FAILED/)
    expect(existsSync(join(lender, "state/current-image"))).toBe(true)
    expect(state("current-image")).toBe("cf:old")
  })
})
