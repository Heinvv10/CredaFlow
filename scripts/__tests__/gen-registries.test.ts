import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buildRegistries } from "../gen-registries"

// A minimal repo: one valid entry per kind, overridable per test. Entry files
// here import nothing (the real ones import only lib/registry/define.ts).
const VALID: Record<string, string> = {
  "lib/registry/audit-actions/a.ts": `export default { LOAN_APPROVED: "LOAN_APPROVED" }`,
  "lib/registry/tenant-scoped-models/a.ts": `export default ["Loan"]`,
  "lib/registry/cron-jobs/a.ts": `export default [{ route: "dpd-update", owner: "external" }]`,
  "lib/registry/simulated-integrations/a.ts": `export default { netcash: { sandboxEnvVar: null, sandboxSafeValues: [] } }`,
  "lib/registry/permissions/a.ts": `export default { view_reports: "READONLY" }`,
  "lib/pdf/.claude.md": "# Module: pdf\n<!-- summary: NCA document hygiene -->\n",
  "prisma/schema/auth.prisma": "enum UserRole {\n  ADMIN\n  // a comment\n  READONLY\n}\n",
}

let root: string | null = null
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

function repo(files: Record<string, string | null>): string {
  root = mkdtempSync(join(tmpdir(), "gen-registries-"))
  for (const [rel, content] of Object.entries({ ...VALID, ...files })) {
    if (content === null) continue
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

describe("gen-registries", () => {
  it("merges entry files in path order", async () => {
    const out = await buildRegistries(
      repo({
        "lib/registry/tenant-scoped-models/b.ts": `export default ["Payment"]`,
        "lib/registry/tenant-scoped-models/0-first.ts": `export default ["Branch"]`,
      }),
    )
    expect(out["lib/registry/generated/tenant-scoped-models.ts"]).toMatch(/"Branch",\s*"Loan",\s*"Payment"/)
  })

  it("refuses an entry two files declare, naming both", async () => {
    const r = repo({ "lib/registry/audit-actions/b.ts": `export default { LOAN_APPROVED: "LOAN_APPROVED" }` })
    await expect(buildRegistries(r)).rejects.toThrow(
      /"LOAN_APPROVED" is declared twice — lib\/registry\/audit-actions\/a\.ts and lib\/registry\/audit-actions\/b\.ts/,
    )
  })

  it("refuses a duplicate tenant-scoped model and a duplicate cron route", async () => {
    await expect(
      buildRegistries(repo({ "lib/registry/tenant-scoped-models/b.ts": `export default ["Loan"]` })),
    ).rejects.toThrow(/"Loan" is declared twice/)
    rmSync(root!, { recursive: true, force: true })
    await expect(
      buildRegistries(
        repo({
          "lib/registry/cron-jobs/b.ts": `export default [{ route: "dpd-update", owner: "in-process", schedule: "0 1 * * *", freshnessMinutes: 60 }]`,
        }),
      ),
    ).rejects.toThrow(/"dpd-update" is declared twice/)
  })

  it("refuses an audit action whose value is not its own name", async () => {
    await expect(
      buildRegistries(repo({ "lib/registry/audit-actions/a.ts": `export default { LOAN_APPROVED: "LOAN_OK" }` })),
    ).rejects.toThrow(/must equal its own name/)
  })

  it("refuses a 6-field (seconds) schedule and a missing freshness budget", async () => {
    await expect(
      buildRegistries(
        repo({
          "lib/registry/cron-jobs/a.ts": `export default [{ route: "x", owner: "in-process", schedule: "*/15 * * * * *", freshnessMinutes: 45 }]`,
        }),
      ),
    ).rejects.toThrow(/exactly 5 fields/)
    rmSync(root!, { recursive: true, force: true })
    await expect(
      buildRegistries(
        repo({ "lib/registry/cron-jobs/a.ts": `export default [{ route: "x", owner: "in-process", schedule: "0 1 * * *" }]` }),
      ),
    ).rejects.toThrow(/freshnessMinutes/)
  })

  it("refuses an unwired route without a reason, and an unknown owner", async () => {
    await expect(
      buildRegistries(repo({ "lib/registry/cron-jobs/a.ts": `export default [{ route: "x", owner: "unwired", reason: " " }]` })),
    ).rejects.toThrow(/without a reason/)
    rmSync(root!, { recursive: true, force: true })
    await expect(
      buildRegistries(repo({ "lib/registry/cron-jobs/a.ts": `export default [{ route: "x", owner: "systemd" }]` })),
    ).rejects.toThrow(/owner must be/)
  })

  it("defaults an in-process job to GET", async () => {
    const out = await buildRegistries(
      repo({
        "lib/registry/cron-jobs/a.ts": `export default [{ route: "x", owner: "in-process", schedule: "0 1 * * *", freshnessMinutes: 60 }]`,
      }),
    )
    expect(out["lib/registry/generated/cron-jobs.ts"]).toContain(`"method": "GET"`)
  })

  it("merges permissions into one map", async () => {
    const out = await buildRegistries(
      repo({ "lib/registry/permissions/b.ts": `export default { manage_settings: "ADMIN" }` }),
    )
    expect(out["lib/registry/generated/permissions.ts"]).toMatch(
      /PERMISSIONS = \{\s*"view_reports": "READONLY",\s*"manage_settings": "ADMIN"\s*\}/,
    )
  })

  it("refuses a module .claude.md without a summary line", async () => {
    await expect(buildRegistries(repo({ "lib/kyc/.claude.md": "# Module: kyc\n" }))).rejects.toThrow(
      /lib\/kyc\/\.claude\.md: needs a "<!-- summary/,
    )
  })

  it("refuses an entry file with no default export", async () => {
    await expect(
      buildRegistries(repo({ "lib/registry/permissions/b.ts": `export const x = { a: "ADMIN" }` })),
    ).rejects.toThrow(/permissions\/b\.ts: no default export/)
  })

  it("refuses a 5-field schedule node-cron would reject at boot", async () => {
    await expect(
      buildRegistries(
        repo({
          "lib/registry/cron-jobs/a.ts": `export default [{ route: "x", owner: "in-process", schedule: "99 99 99 99 99", freshnessMinutes: 60 }]`,
        }),
      ),
    ).rejects.toThrow(/not a valid cron expression/)
  })

  describe("`after`: a job that waits for another single-run job", () => {
    const job = (route: string, schedule: string, extra = "singleRun: true") =>
      `{ route: "${route}", owner: "in-process", schedule: "${schedule}", freshnessMinutes: 60, ${extra} }`
    const jobs = (entries: string[]) => repo({ "lib/registry/cron-jobs/a.ts": `export default [${entries.join(", ")}]` })

    it("accepts a single-run job that waits for an earlier single-run job", async () => {
      const out = await buildRegistries(jobs([job("first", "0 7 * * *"), job("second", "30 7 * * *", 'singleRun: true, after: "first"')]))
      expect(out["lib/registry/generated/cron-jobs.ts"]).toContain(`"after": "first"`)
    })

    it("refuses a waiting job that is not itself single-run: it has no firings of its own to wait with", async () => {
      await expect(buildRegistries(jobs([job("first", "0 7 * * *"), job("second", "30 7 * * *", 'after: "first"')]))).rejects.toThrow(/second: after "first" needs second to be singleRun/)
    })

    it("refuses an `after` that is not a single-run in-process job", async () => {
      await expect(buildRegistries(jobs([job("first", "0 7 * * *", "freshnessMinutes: 60"), job("second", "30 7 * * *", 'singleRun: true, after: "first"')]))).rejects.toThrow(/after "first" must name a singleRun in-process job/)
      await expect(buildRegistries(jobs([job("second", "30 7 * * *", 'singleRun: true, after: "nope"')]))).rejects.toThrow(/after "nope" must name a singleRun in-process job/)
    })

    it("refuses a job whose final firing is not after the final firing of the job it waits for", async () => {
      await expect(buildRegistries(jobs([job("first", "30 7 * * *"), job("second", "0 7 * * *", 'singleRun: true, after: "first"')]))).rejects.toThrow(/final firing must come after first's/)
      await expect(buildRegistries(jobs([job("first", "0 7 * * *"), job("second", "0 7 * * *", 'singleRun: true, after: "first"')]))).rejects.toThrow(/final firing must come after first's/)
    })
  })

  it("refuses a field the owner does not take, so a schedule is never silently dropped", async () => {
    await expect(
      buildRegistries(
        repo({ "lib/registry/cron-jobs/a.ts": `export default [{ route: "x", owner: "external", schedule: "0 1 * * *" }]` }),
      ),
    ).rejects.toThrow(/x \(external\) does not take schedule/)
  })

  it.each([
    ["lib/registry/audit-actions/b.mts", "export default {}"],
    ["lib/registry/cron-jobs/b.js", "export default []"],
    ["lib/registry/cron-jobs/b.tsx", "export default []"],
    ["lib/registry/cron-jobs/types.d.ts", "export {}"],
    ["lib/registry/audit-actions/b.test.ts", "export default {}"],
    ["lib/registry/cron-jobs/sub/a.ts", "export default []"],
  ])("refuses %s rather than skipping it", async (path, content) => {
    await expect(buildRegistries(repo({ [path]: content }))).rejects.toThrow(/not an entry file/)
  })

  it("refuses a permission role that is not a UserRole", async () => {
    await expect(
      buildRegistries(repo({ "lib/registry/permissions/a.ts": `export default { x: "SUPERDUPER" }` })),
    ).rejects.toThrow(/x must name a UserRole, got "SUPERDUPER"/)
    rmSync(root!, { recursive: true, force: true })
    await expect(
      buildRegistries(repo({ "lib/registry/permissions/a.ts": `export default { x: { server: "ADMIN" } }` })),
    ).rejects.toThrow(/x must name a UserRole/)
  })

  // A role list grants exactly the roles named, off the ladder: how a
  // specialist role (INSURANCE_OFFICER) is kept out of a write that roles
  // below it on the ladder may make.
  // One build per test: four builds in one test overran the 5 s budget on a loaded host.
  it("accepts an explicit role list", async () => {
    const out = await buildRegistries(repo({ "lib/registry/permissions/b.ts": `export default { y: ["ADMIN", "READONLY"] }` }))
    expect(out["lib/registry/generated/permissions.ts"]).toMatch(/"y": \[\s*"ADMIN",\s*"READONLY"\s*\]/)
  })

  it.each([`[]`, `["ADMIN", "ADMIN"]`, `["ADMIN", "SUPERDUPER"]`])("refuses the role list %s", async (bad) => {
    await expect(
      buildRegistries(repo({ "lib/registry/permissions/b.ts": `export default { y: ${bad} }` })),
    ).rejects.toThrow(/y must name a UserRole or a non-empty list of distinct UserRoles/)
  })
})
