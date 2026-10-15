/**
 * Behavioural proof of migration 20261014180000_w4_screening_round2, in plain
 * SQL: per-lender maker-checker (requireSecondReviewer), fingerprint-based
 * staleness (N6), identity-bound carry (N2) and entity-context blocks (N7).
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/screening/db-enforcement-round2.integration.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_SCREENING_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "").slice(0, 16)
const n = () => randomUUID().slice(0, 8)

function run(value: string): { ok: boolean; output: string } {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the screening integration test")
  const result = spawnSync("psql", ["--no-psqlrc", "--dbname", databaseUrl, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-c", value], { encoding: "utf8" })
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
}
function sql(value: string): string {
  const result = run(value)
  if (!result.ok) throw new Error(result.output)
  return result.output.trim()
}

suite("screening round-2 enforcement in the database", () => {
  const t = `tenant_scr2_${token}`
  const product = `product_scr2_${token}`
  const admin = `admin_scr2_${token}`
  let otherTriggers: string[] = []
  let checks: string[] = []
  const client = (id: string) => sql(`INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
    VALUES ('${id}', '${t}', 'REF-${id}', 'ID-${id}', 'Synthetic', 'Round Two', '${id}@test.invalid', '+27820000000', now())`)
  const setSecondReviewer = (on: boolean) => sql(`UPDATE "TenantConfig" SET "requireSecondReviewer" = ${on} WHERE "tenantId" = '${t}'`)
  /** A PEP possible-match row for the client's current identity, started by `starter`. */
  const pepMatch = (id: string, c: string, starter = admin, extra = "") => {
    const [cols, vals] = extra ? extra.split("|") : ["", ""]
    return run(`INSERT INTO "ScreeningCheck" ("id", "tenantId", "clientId", "runId", "trigger", "provider", "type", "result", "matchFingerprint", "matches", "subjectFingerprint", "triggeredById"${cols ? ", " + cols : ""})
      VALUES ('${id}', '${t}', '${c}', 'run_${id}', 'MANUAL', 'simulated', 'PEP', 'POSSIBLE_MATCH', 'mfp', '[{"listEntryId": "E1"}]'::jsonb,
        "screeningCurrentFingerprint"('${t}', '${c}', NULL), '${starter}'${vals ? ", " + vals : ""})`)
  }
  const decideSql = (id: string, by: string) =>
    `UPDATE "ScreeningCheck" SET decision = 'FALSE_POSITIVE', "decisionReason" = 'Different date of birth on the list.', "reviewedById" = '${by}', "reviewedAt" = now() WHERE id = '${id}'`

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('${t}', 'scr2-${token}', 'Screening round 2', now());
      INSERT INTO "TenantConfig" ("id", "tenantId", "screeningProvider", "updatedAt") VALUES ('cfg2_${token}', '${t}', 'simulated', now());
      INSERT INTO "User" ("id", "tenantId", "email", "password", "role", "updatedAt") VALUES ('${admin}', '${t}', 'a2-${token}@test.invalid', 'x', 'ADMIN', now());
      INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
        VALUES ('${product}', '${t}', 'SCR2-${token}', 'Round 2 product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL');`)
    otherTriggers = sql(`SELECT tgname FROM pg_trigger WHERE tgrelid = '"LoanApplication"'::regclass AND NOT tgisinternal AND tgname <> 'LoanApplication_a1_guard_screening'`).split("\n").filter(Boolean)
    checks = sql(`SELECT conname FROM pg_constraint WHERE conrelid = '"LoanApplication"'::regclass AND contype = 'c'`).split("\n").filter(Boolean)
  })

  it("maker-checker follows TenantConfig.requireSecondReviewer for screening, STR and RMCP decisions", () => {
    const c = `c_mc2_${n()}`
    client(c)
    const str = `str_${n()}`
    const rmcp = `rmcp_${n()}`
    sql(`INSERT INTO "SuspiciousReportCase" ("id", "tenantId", "reference", "kind", "clientId", "grounds", "raisedById", "updatedAt")
      VALUES ('${str}', '${t}', 'STR-${str}', 'SUSPICIOUS_TRANSACTION', '${c}', 'Cash deposits just under the threshold on three days.', '${admin}', now());
      INSERT INTO "RmcpDocument" ("id", "tenantId", "version", "title", "fileName", "mimeType", "storagePath", "sha256", "fileSize", "uploadedById", "reviewDueAt")
      VALUES ('${rmcp}', '${t}', 1, 'RMCP', 'rmcp.pdf', 'application/pdf', '/tmp/none.pdf', '${"a".repeat(64)}', 10, '${admin}', '2027-10-14')`)
    const screen = `sc_${n()}`
    expect(pepMatch(screen, c).ok).toBe(true)
    const closeStr = `UPDATE "SuspiciousReportCase" SET status = 'CLOSED_NO_REPORT', "assessmentNote" = 'Explained by a salary advance.', "assessedById" = '${admin}', "assessedAt" = now(), "closedAt" = now() WHERE id = '${str}'`
    const approveRmcp = `UPDATE "RmcpDocument" SET "approvedById" = '${admin}', "approvedAt" = now() WHERE id = '${rmcp}'`

    setSecondReviewer(true)
    expect(run(decideSql(screen, admin)).output).toContain("ScreeningCheck_maker_checker")
    expect(run(closeStr).output).toContain("SuspiciousReportCase_maker_checker")
    expect(run(approveRmcp).output).toContain("RmcpDocument_maker_checker")

    setSecondReviewer(false)
    expect(run(decideSql(screen, admin)).ok).toBe(true)
    expect(run(closeStr).ok).toBe(true)
    expect(run(approveRmcp).ok).toBe(true)
    setSecondReviewer(true)
  })

  it("N6: a whitespace-only name edit keeps a client CLEARED; a real change makes it PENDING", () => {
    const c = `c_n6_${n()}`
    client(c)
    sql(`UPDATE "Client" SET "amlScreeningStatus" = 'CLEARED' WHERE id = '${c}'`)
    sql(`UPDATE "Client" SET "lastName" = '  Round   Two ' WHERE id = '${c}'`)
    expect(sql(`SELECT "amlScreeningStatus" FROM "Client" WHERE id = '${c}'`)).toBe("CLEARED")
    sql(`UPDATE "Client" SET "lastName" = 'Round Three' WHERE id = '${c}'`)
    expect(sql(`SELECT "amlScreeningStatus" FROM "Client" WHERE id = '${c}'`)).toBe("PENDING")
  })

  it("N2: the database refuses a carried decision from a check of a different identity", () => {
    const c = `c_n2_${n()}`
    client(c)
    const src = `src_${n()}`
    expect(pepMatch(src, c, "someone-else").ok).toBe(true)
    sql(decideSql(src, admin))
    sql(`UPDATE "Client" SET "lastName" = 'Renamed After Clearance' WHERE id = '${c}'`)
    const carried = `"decision", "decisionReason", "reviewedAt", "carriedFromCheckId"|'FALSE_POSITIVE', 'Different date of birth on the list.', now(), '${src}'`
    expect(pepMatch(`carry_${n()}`, c, "someone-else", carried).output).toContain("ScreeningCheck_born_undecided")
  })

  it("N7: a block raised on a person screened for an entity refuses the entity's approval with no relationship row at all", () => {
    const e = `e_n7_${n()}`
    const p = `c_n7_${n()}`
    sql(`INSERT INTO "BusinessEntity" ("id", "tenantId", "type", "legalName", "registrationNumber", "updatedAt") VALUES ('${e}', '${t}', 'COMPANY', 'Synthetic Context Ltd', 'REG-${e}', now())`)
    client(p)
    for (const type of ["PEP", "SANCTIONS", "ADVERSE_MEDIA"]) {
      sql(`INSERT INTO "ScreeningCheck" ("id", "tenantId", "entityId", "runId", "trigger", "provider", "type", "result", "subjectFingerprint")
        VALUES ('er_${e}_${type}', '${t}', '${e}', 'er_${e}', 'MANUAL', 'simulated', '${type}', 'CLEAR', "screeningCurrentFingerprint"('${t}', NULL, '${e}'))`)
    }
    sql(`INSERT INTO "ScreeningCheck" ("id", "tenantId", "clientId", "contextEntityId", "runId", "trigger", "provider", "type", "result", "matchFingerprint", "matches", "subjectFingerprint")
      VALUES ('pr_${p}', '${t}', '${p}', '${e}', 'pr_${p}', 'MANUAL', 'simulated', 'SANCTIONS', 'CONFIRMED_MATCH', 'mfp', '[{"listEntryId": "S1"}]'::jsonb, "screeningCurrentFingerprint"('${t}', '${p}', NULL))`)
    expect(sql(`SELECT "contextEntityId" FROM "ScreeningBlock" WHERE "sourceCheckId" = 'pr_${p}'`)).toBe(e)
    sql(`INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "entityId", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
      VALUES ('a_${e}', '${t}', 'APP-${e}', '${e}', '${product}', 500000, 30, 'UNDER_REVIEW', now())`)
    const approve = run(`
      BEGIN;
      ${otherTriggers.map((x) => `ALTER TABLE "LoanApplication" DISABLE TRIGGER "${x}";`).join("\n")}
      ${checks.map((x) => `ALTER TABLE "LoanApplication" DROP CONSTRAINT "${x}";`).join("\n")}
      UPDATE "LoanApplication" SET status = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = now() WHERE id = 'a_${e}';
      ROLLBACK;`)
    expect(approve.output).toContain("LoanApplication_screening_blocks_approval")
    expect(run(`UPDATE "ScreeningCheck" SET "contextEntityId" = NULL WHERE id = 'pr_${p}'`).output).toContain("ScreeningCheck_transition")
  })
})
