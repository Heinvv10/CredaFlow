/**
 * Behavioural proof of the screening enforcement in migration
 * 20261014150000_w4_screening_fic, written as plain SQL so no application
 * code is between the statement and the database:
 *
 *   - LoanApplication_a1_guard_screening refuses APPROVED / DISBURSED while the
 *     client's latest run blocks, and never touches a tenant without a provider
 *   - ScreeningCheck_guard_record: no delete, one-time decision, no pre-decided rows
 *   - ScreeningCheck_sanctions_never_cleared: a confirmed sanctions match takes no decision
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/screening/db-enforcement.integration.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_SCREENING_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "").slice(0, 16)
const TRIGGER = "LoanApplication_a1_guard_screening"

function run(value: string): { ok: boolean; output: string } {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the screening integration test")
  const result = spawnSync(
    "psql",
    ["--no-psqlrc", "--dbname", databaseUrl, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-c", value],
    { encoding: "utf8" },
  )
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}` }
}

function sql(value: string): string {
  const result = run(value)
  if (!result.ok) throw new Error(result.output)
  return result.output.trim()
}

suite("screening enforcement in the database", () => {
  const tenantId = `tenant_scrdb_${token}`
  const bareTenantId = `tenant_scrdb_bare_${token}`
  const productId = `product_scrdb_${token}`
  let otherTriggers: string[] = []
  let checks: string[] = []

  const clientSql = (id: string, tenant = tenantId) => `
    INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
    VALUES ('${id}', '${tenant}', 'REF-${id}', 'ID-${id}', 'Synthetic', 'Screened', '${id}@test.invalid', '+27820000000', now());`
  const appSql = (id: string, clientId: string, tenant = tenantId, product = productId) => `
    INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
    VALUES ('${id}', '${tenant}', 'APP-${id}', '${clientId}', '${product}', 500000, 30, 'UNDER_REVIEW', now());`
  /** A check row for the client's CURRENT identity (subjectFingerprint from the same SQL the trigger uses). */
  const checkSql = (id: string, clientId: string, runId: string, type: string, result: string, extra = "", matches = `[{"listEntryId": "E-${type}"}]`, fingerprint = `fp-${type}-${result}`) => {
    const isMatch = result === "POSSIBLE_MATCH" || result === "CONFIRMED_MATCH"
    return `
    INSERT INTO "ScreeningCheck" ("id", "tenantId", "clientId", "runId", "trigger", "provider", "type", "result", "matchFingerprint", "matches", "subjectFingerprint", "createdAt" ${extra ? ", " + extra.split("|")[0] : ""})
    VALUES ('${id}', '${tenantId}', '${clientId}', '${runId}', 'MANUAL', 'simulated', '${type}', '${result}',
      ${isMatch ? `'${fingerprint}'` : "NULL"}, '${isMatch ? matches : "[]"}'::jsonb,
      "screeningCurrentFingerprint"('${tenantId}', '${clientId}', NULL), now() ${extra ? ", " + extra.split("|")[1] : ""});`
  }
  const cleanRun = (clientId: string, runId: string) =>
    ["PEP", "SANCTIONS", "ADVERSE_MEDIA"].map((t) => checkSql(`${runId}_${t}`, clientId, runId, t, "CLEAR")).join("\n")

  /** The approval write with every OTHER LoanApplication trigger and CHECK out of the way, rolled back. */
  const isolatedApproval = (appId: string, status = "APPROVED") => `
    BEGIN;
    ${otherTriggers.map((t) => `ALTER TABLE "LoanApplication" DISABLE TRIGGER "${t}";`).join("\n")}
    ${checks.map((c) => `ALTER TABLE "LoanApplication" DROP CONSTRAINT "${c}";`).join("\n")}
    UPDATE "LoanApplication" SET status = '${status}', "repaymentMethod" = 'EFT', "approvedAt" = now() WHERE id = '${appId}';
    SELECT status FROM "LoanApplication" WHERE id = '${appId}';
    ROLLBACK;`

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES
        ('${tenantId}', 'scrdb-${token}', 'Screening DB test', now()),
        ('${bareTenantId}', 'scrdb-bare-${token}', 'No screening', now());
      INSERT INTO "TenantConfig" ("id", "tenantId", "screeningProvider", "updatedAt") VALUES ('cfg_${token}', '${tenantId}', 'simulated', now());
      INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
        VALUES ('${productId}', '${tenantId}', 'SCR-${token}', 'Screening product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL'),
               ('${productId}_bare', '${bareTenantId}', 'SCRB-${token}', 'Bare product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL');
    `)
    otherTriggers = sql(`SELECT tgname FROM pg_trigger WHERE tgrelid = '"LoanApplication"'::regclass AND NOT tgisinternal AND tgname <> '${TRIGGER}'`)
      .split("\n").filter(Boolean)
    checks = sql(`SELECT conname FROM pg_constraint WHERE conrelid = '"LoanApplication"'::regclass AND contype = 'c'`)
      .split("\n").filter(Boolean)
    expect(otherTriggers.length).toBeGreaterThan(0)
  })

  it("refuses approval of a client never screened, and allows it once a clear run exists", () => {
    const c = `c_unscreened_${token}`
    sql(clientSql(c) + appSql(`a_unscreened_${token}`, c))
    const refused = run(isolatedApproval(`a_unscreened_${token}`))
    expect(refused.ok).toBe(false)
    expect(refused.output).toContain("LoanApplication_screening_required")
    sql(cleanRun(c, `r_clear_${token}`))
    expect(sql(isolatedApproval(`a_unscreened_${token}`))).toContain("APPROVED")
  })

  it("refuses approval and disbursement while a PEP match is undecided, allows it once ACCEPTED", () => {
    const c = `c_pep_${token}`
    const r = `r_pep_${token}`
    sql(clientSql(c) + appSql(`a_pep_${token}`, c) + checkSql(`${r}_PEP`, c, r, "PEP", "CONFIRMED_MATCH")
      + checkSql(`${r}_S`, c, r, "SANCTIONS", "CLEAR") + checkSql(`${r}_M`, c, r, "ADVERSE_MEDIA", "CLEAR"))
    for (const status of ["APPROVED", "DISBURSED"]) {
      const refused = run(isolatedApproval(`a_pep_${token}`, status))
      expect(refused.ok, status).toBe(false)
      expect(refused.output).toContain("LoanApplication_screening_blocks_approval")
    }
    sql(`UPDATE "ScreeningCheck" SET decision = 'ACCEPTED', "decisionReason" = 'Senior accepted with enhanced due diligence.', "reviewedById" = 'u1', "reviewedAt" = now() WHERE id = '${r}_PEP'`)
    expect(sql(isolatedApproval(`a_pep_${token}`))).toContain("APPROVED")
  })

  it("never lets a confirmed sanctions match take a decision, so approval stays refused", () => {
    const c = `c_sanction_${token}`
    const r = `r_sanction_${token}`
    sql(clientSql(c) + appSql(`a_sanction_${token}`, c) + checkSql(`${r}_S`, c, r, "SANCTIONS", "CONFIRMED_MATCH")
      + checkSql(`${r}_P`, c, r, "PEP", "CLEAR") + checkSql(`${r}_M`, c, r, "ADVERSE_MEDIA", "CLEAR"))
    for (const decision of ["FALSE_POSITIVE", "ACCEPTED", "REJECTED"]) {
      const result = run(`UPDATE "ScreeningCheck" SET decision = '${decision}', "decisionReason" = 'Trying to clear a sanctions match.', "reviewedById" = 'u1', "reviewedAt" = now() WHERE id = '${r}_S'`)
      expect(result.ok, decision).toBe(false)
      expect(result.output).toContain("ScreeningCheck_sanctions_never_cleared")
    }
    expect(run(isolatedApproval(`a_sanction_${token}`)).output).toContain("LoanApplication_screening_blocks_approval")
  })

  it("refuses approval while the latest run has a provider error or a REJECTED match", () => {
    const c = `c_err_${token}`
    sql(clientSql(c) + appSql(`a_err_${token}`, c) + cleanRun(c, `r_old_${token}`))
    sql(`SELECT pg_sleep(0.01);` + checkSql(`r_err_${token}_P`, c, `r_err_${token}`, "PEP", "ERROR")
      + checkSql(`r_err_${token}_S`, c, `r_err_${token}`, "SANCTIONS", "CLEAR") + checkSql(`r_err_${token}_M`, c, `r_err_${token}`, "ADVERSE_MEDIA", "CLEAR"))
    expect(run(isolatedApproval(`a_err_${token}`)).output).toContain("LoanApplication_screening_blocks_approval")
  })

  it("leaves a tenant without a screening provider untouched", () => {
    const c = `c_bare_${token}`
    sql(clientSql(c, bareTenantId) + appSql(`a_bare_${token}`, c, bareTenantId, `${productId}_bare`))
    expect(sql(isolatedApproval(`a_bare_${token}`))).toContain("APPROVED")
  })

  it("keeps a check a record: no delete or truncate, one decision only, nothing but the decision changes", () => {
    const c = `c_rec_${token}`
    const r = `r_rec_${token}`
    sql(clientSql(c) + checkSql(`${r}_P`, c, r, "PEP", "POSSIBLE_MATCH"))
    expect(run(`DELETE FROM "ScreeningCheck" WHERE id = '${r}_P'`).output).toContain("ScreeningCheck_no_delete")
    expect(run(`TRUNCATE "ScreeningCheck" CASCADE`).output).toContain("ScreeningCheck_no_delete")
    expect(run(`UPDATE "ScreeningCheck" SET result = 'CLEAR', "matchFingerprint" = NULL WHERE id = '${r}_P'`).output).toContain("ScreeningCheck_transition")
    const short = run(`UPDATE "ScreeningCheck" SET decision = 'FALSE_POSITIVE', "decisionReason" = 'too short', "reviewedById" = 'u1', "reviewedAt" = now() WHERE id = '${r}_P'`)
    expect(short.output).toContain("ScreeningCheck_decision_complete")
    sql(`UPDATE "ScreeningCheck" SET decision = 'FALSE_POSITIVE', "decisionReason" = 'Different date of birth on the list.', "reviewedById" = 'u1', "reviewedAt" = now() WHERE id = '${r}_P'`)
    expect(run(`UPDATE "ScreeningCheck" SET decision = 'REJECTED' WHERE id = '${r}_P'`).output).toContain("ScreeningCheck_decided_immutable")
  })

  it("refuses a check inserted already decided unless it carries an identical earlier clearance at the same result level (never sanctions)", () => {
    const c = `c_born_${token}`
    sql(clientSql(c))
    const decided = `"decision", "decisionReason", "reviewedAt", "reviewedById"|'ACCEPTED', 'Pre-cleared before anyone looked.', now(), 'u1'`
    expect(run(checkSql(`forged_${token}`, c, `r_forged_${token}`, "PEP", "POSSIBLE_MATCH", decided)).output).toContain("ScreeningCheck_born_undecided")
    sql(checkSql(`src_${token}`, c, `r_src_${token}`, "PEP", "POSSIBLE_MATCH"))
    sql(`UPDATE "ScreeningCheck" SET decision = 'ACCEPTED', "decisionReason" = 'Senior accepted with enhanced due diligence.', "reviewedById" = 'u1', "reviewedAt" = now() WHERE id = 'src_${token}'`)
    const carried = (decision = "ACCEPTED") => `"decision", "decisionReason", "reviewedAt", "carriedFromCheckId"|'${decision}', 'Senior accepted with enhanced due diligence.', now(), 'src_${token}'`
    expect(run(checkSql(`carry_${token}`, c, `r_carry_${token}`, "PEP", "POSSIBLE_MATCH", carried())).ok).toBe(true)
    expect(run(checkSql(`carry2_${token}`, c, `r_carry2_${token}`, "PEP", "POSSIBLE_MATCH", carried("FALSE_POSITIVE"))).output).toContain("ScreeningCheck_born_undecided")
    // M1: never upward, from a possible-match clearance onto a CONFIRMED_MATCH —
    // even with a forged identical fingerprint, so only the level rule can refuse it.
    expect(run(checkSql(`carry3_${token}`, c, `r_carry3_${token}`, "PEP", "CONFIRMED_MATCH", carried(), undefined, "fp-PEP-POSSIBLE_MATCH")).output).toContain("ScreeningCheck_born_undecided")
    // Policy 2026-10-14: same level is fine — a confirmed PEP clearance onto the identical confirmed match.
    sql(checkSql(`csrc_${token}`, c, `r_csrc_${token}`, "PEP", "CONFIRMED_MATCH"))
    sql(`UPDATE "ScreeningCheck" SET decision = 'ACCEPTED', "decisionReason" = 'Senior accepted with enhanced due diligence.', "reviewedById" = 'u1', "reviewedAt" = now() WHERE id = 'csrc_${token}'`)
    const fromConfirmed = `"decision", "decisionReason", "reviewedAt", "carriedFromCheckId"|'ACCEPTED', 'Senior accepted with enhanced due diligence.', now(), 'csrc_${token}'`
    expect(run(checkSql(`ccarry_${token}`, c, `r_ccarry_${token}`, "PEP", "CONFIRMED_MATCH", fromConfirmed)).ok).toBe(true)
    // Never for SANCTIONS, even an identical cleared possible match.
    sql(checkSql(`ssrc_${token}`, c, `r_ssrc_${token}`, "SANCTIONS", "POSSIBLE_MATCH"))
    sql(`UPDATE "ScreeningCheck" SET decision = 'FALSE_POSITIVE', "decisionReason" = 'Different date of birth on the list.', "reviewedById" = 'u1', "reviewedAt" = now() WHERE id = 'ssrc_${token}'`)
    const fromSanctions = `"decision", "decisionReason", "reviewedAt", "carriedFromCheckId"|'FALSE_POSITIVE', 'Different date of birth on the list.', now(), 'ssrc_${token}'`
    expect(run(checkSql(`scarry_${token}`, c, `r_scarry_${token}`, "SANCTIONS", "POSSIBLE_MATCH", fromSanctions)).output).toContain("ScreeningCheck_born_undecided")
    // M2: never when there are no matches, or one lacks its list-entry id.
    for (const [n, matches] of [["4", "[]"], ["5", `[{"listEntryId": ""}]`], ["6", `[{"listName": "x"}]`]]) {
      expect(run(checkSql(`carry${n}_${token}`, c, `r_carry${n}_${token}`, "PEP", "POSSIBLE_MATCH", carried(), matches)).output, matches).toContain("ScreeningCheck_born_undecided")
    }
  })

  it("refuses a check that does not name the identity it screened", () => {
    const c = `c_nofp_${token}`
    sql(clientSql(c))
    const noFp = checkSql(`nofp_${token}`, c, `r_nofp_${token}`, "PEP", "CLEAR").replace(`"screeningCurrentFingerprint"('${tenantId}', '${c}', NULL)`, "NULL")
    expect(run(noFp).output).toContain("ScreeningCheck_subject_fingerprint")
  })
})
