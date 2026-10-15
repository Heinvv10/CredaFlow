/**
 * Behavioural proof of migration 20261014160000_w4_screening_review_fixes, in
 * plain SQL: identity-bound runs (H1), sticky blocks and their lift (H2),
 * entity borrowers and their related parties (H3), maker-checker CHECKs.
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/screening/db-enforcement-round1.integration.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_SCREENING_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "").slice(0, 16)

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

suite("screening round-1 enforcement in the database", () => {
  const t = `tenant_scr1_${token}`
  const product = `product_scr1_${token}`
  const superAdmin = `sa_scr1_${token}`
  const admin = `admin_scr1_${token}`
  let otherTriggers: string[] = []
  let checks: string[] = []
  const n = () => randomUUID().slice(0, 8)

  const client = (id: string) => sql(`INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
    VALUES ('${id}', '${t}', 'REF-${id}', 'ID-${id}', 'Synthetic', 'Round One', '${id}@test.invalid', '+27820000000', now())`)
  const entity = (id: string) => sql(`INSERT INTO "BusinessEntity" ("id", "tenantId", "type", "legalName", "registrationNumber", "updatedAt")
    VALUES ('${id}', '${t}', 'COMPANY', 'Synthetic Holdings', 'REG-${id}', now())`)
  const app = (id: string, col: "clientId" | "entityId", subject: string) => sql(`INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "${col}", "productId", "appliedAmount", "appliedTermDays", "status", "updatedAt")
    VALUES ('${id}', '${t}', 'APP-${id}', '${subject}', '${product}', 500000, 30, 'UNDER_REVIEW', now())`)
  /** One check row for the subject's current identity; result CLEAR unless given. */
  const check = (col: "clientId" | "entityId", subject: string, runId: string, type: string, result = "CLEAR", extra = "") => {
    const isMatch = result === "POSSIBLE_MATCH" || result === "CONFIRMED_MATCH"
    const [cols, vals] = extra ? extra.split("|") : ["", ""]
    return sql(`INSERT INTO "ScreeningCheck" ("id", "tenantId", "${col}", "runId", "trigger", "provider", "type", "result", "matchFingerprint", "matches", "subjectFingerprint", "createdAt"${cols ? ", " + cols : ""})
      VALUES ('${runId}_${type}', '${t}', '${subject}', '${runId}', 'MANUAL', 'simulated', '${type}', '${result}', ${isMatch ? "'fp'" : "NULL"},
        '${isMatch ? `[{"listEntryId": "E1"}]` : "[]"}'::jsonb,
        "screeningCurrentFingerprint"('${t}', ${col === "clientId" ? `'${subject}'` : "NULL"}, ${col === "entityId" ? `'${subject}'` : "NULL"}), clock_timestamp()${vals ? ", " + vals : ""})`)
  }
  const cleanRun = (col: "clientId" | "entityId", subject: string, runId = `r_${n()}`) => {
    for (const type of ["PEP", "SANCTIONS", "ADVERSE_MEDIA"]) check(col, subject, runId, type)
  }
  const approve = (appId: string) => run(`
    BEGIN;
    ${otherTriggers.map((x) => `ALTER TABLE "LoanApplication" DISABLE TRIGGER "${x}";`).join("\n")}
    ${checks.map((c) => `ALTER TABLE "LoanApplication" DROP CONSTRAINT "${c}";`).join("\n")}
    UPDATE "LoanApplication" SET status = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = now() WHERE id = '${appId}';
    ROLLBACK;`)

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('${t}', 'scr1-${token}', 'Screening round 1', now());
      INSERT INTO "TenantConfig" ("id", "tenantId", "screeningProvider", "updatedAt") VALUES ('cfg1_${token}', '${t}', 'simulated', now());
      INSERT INTO "User" ("id", "tenantId", "email", "password", "role", "updatedAt") VALUES
        ('${superAdmin}', '${t}', 'sa-${token}@test.invalid', 'x', 'SUPER_ADMIN', now()),
        ('${admin}', '${t}', 'admin-${token}@test.invalid', 'x', 'ADMIN', now());
      INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
        VALUES ('${product}', '${t}', 'SCR1-${token}', 'Round 1 product', 'PERSONAL', 100000, 1000000, 30, 90, 0.03, 'DAILY_ACCRUAL');`)
    otherTriggers = sql(`SELECT tgname FROM pg_trigger WHERE tgrelid = '"LoanApplication"'::regclass AND NOT tgisinternal AND tgname <> 'LoanApplication_a1_guard_screening'`).split("\n").filter(Boolean)
    checks = sql(`SELECT conname FROM pg_constraint WHERE conrelid = '"LoanApplication"'::regclass AND contype = 'c'`).split("\n").filter(Boolean)
  })

  it("H1: a run of the old identity no longer satisfies approval, and the client drops from CLEARED to PENDING", () => {
    const c = `c_h1_${n()}`
    client(c)
    app(`a_${c}`, "clientId", c)
    cleanRun("clientId", c)
    sql(`UPDATE "Client" SET "amlScreeningStatus" = 'CLEARED' WHERE id = '${c}'`)
    expect(approve(`a_${c}`).ok).toBe(true)
    sql(`UPDATE "Client" SET "idNumber" = 'ID-changed-${c}' WHERE id = '${c}'`)
    expect(sql(`SELECT "amlScreeningStatus" FROM "Client" WHERE id = '${c}'`)).toBe("PENDING")
    expect(approve(`a_${c}`).output).toContain("LoanApplication_screening_required")
    cleanRun("clientId", c)
    expect(approve(`a_${c}`).ok).toBe(true)
  })

  it("H2: a sanctions match raises a sticky block a later clear run does not lift; only an active SUPER_ADMIN lifts it, with a reason, once", () => {
    const c = `c_h2_${n()}`
    client(c)
    app(`a_${c}`, "clientId", c)
    const r = `r_${n()}`
    check("clientId", c, r, "SANCTIONS", "CONFIRMED_MATCH")
    const block = sql(`SELECT id || '|' || reason FROM "ScreeningBlock" WHERE "sourceCheckId" = '${r}_SANCTIONS'`)
    expect(block.split("|")[1]).toBe("SANCTIONS_MATCH")
    const blockId = block.split("|")[0]
    cleanRun("clientId", c)
    expect(approve(`a_${c}`).output).toContain("LoanApplication_screening_blocks_approval")
    expect(run(`UPDATE "ScreeningBlock" SET "liftedById" = '${admin}', "liftedAt" = now(), "liftReason" = 'An admin trying to lift it.' WHERE id = '${blockId}'`).output)
      .toContain("ScreeningBlock_lift_requires_super_admin")
    expect(run(`UPDATE "ScreeningBlock" SET "liftedById" = '${superAdmin}', "liftedAt" = now(), "liftReason" = 'short' WHERE id = '${blockId}'`).output)
      .toContain("ScreeningBlock_lift_complete")
    expect(run(`DELETE FROM "ScreeningBlock" WHERE id = '${blockId}'`).output).toContain("ScreeningBlock_no_delete")
    sql(`UPDATE "ScreeningBlock" SET "liftedById" = '${superAdmin}', "liftedAt" = now(), "liftReason" = 'List entry removed; new run is clear.' WHERE id = '${blockId}'`)
    expect(approve(`a_${c}`).ok).toBe(true)
    expect(run(`UPDATE "ScreeningBlock" SET "liftedAt" = NULL, "liftedById" = NULL, "liftReason" = NULL WHERE id = '${blockId}'`).output).toContain("ScreeningBlock_transition")
  })

  it("H2: a REJECTED decision raises a sticky block; a forged block is refused", () => {
    const c = `c_rej_${n()}`
    client(c)
    const r = `r_${n()}`
    check("clientId", c, r, "PEP", "CONFIRMED_MATCH")
    sql(`UPDATE "ScreeningCheck" SET decision = 'REJECTED', "decisionReason" = 'The match is this client; declined.', "reviewedById" = '${admin}', "reviewedAt" = now() WHERE id = '${r}_PEP'`)
    expect(sql(`SELECT reason FROM "ScreeningBlock" WHERE "sourceCheckId" = '${r}_PEP'`)).toBe("REJECTED")
    const clean = `r_${n()}`
    cleanRun("clientId", c, clean)
    expect(run(`INSERT INTO "ScreeningBlock" ("id", "tenantId", "clientId", "sourceCheckId", "reason") VALUES ('forged_${n()}', '${t}', '${c}', '${clean}_PEP', 'REJECTED')`).output)
      .toContain("ScreeningBlock_born_from_check")
  })

  it("H3: an entity application needs the entity screened and every active related party clear", () => {
    const e = `e_h3_${n()}`
    const director = `c_dir_${n()}`
    const formerDirector = `c_old_${n()}`
    entity(e)
    client(director)
    client(formerDirector)
    sql(`INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "updatedAt") VALUES ('er_${n()}', '${t}', '${e}', '${director}', 'DIRECTOR', now());
         INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "active", "updatedAt") VALUES ('er_${n()}', '${t}', '${e}', '${formerDirector}', 'DIRECTOR', false, now())`)
    app(`a_${e}`, "entityId", e)
    expect(approve(`a_${e}`).output).toContain("LoanApplication_screening_required")
    cleanRun("entityId", e)
    expect(approve(`a_${e}`).output).toContain("LoanApplication_screening_required")
    const r = `r_${n()}`
    check("clientId", director, r, "PEP", "CONFIRMED_MATCH")
    check("clientId", director, r, "SANCTIONS")
    check("clientId", director, r, "ADVERSE_MEDIA")
    expect(approve(`a_${e}`).output).toContain("LoanApplication_screening_blocks_approval")
    sql(`UPDATE "ScreeningCheck" SET decision = 'ACCEPTED', "decisionReason" = 'Director is a PEP; EDD done and accepted.', "reviewedById" = '${admin}', "reviewedAt" = now() WHERE id = '${r}_PEP'`)
    expect(approve(`a_${e}`).ok).toBe(true)
  })

  it("maker-checker and one-subject CHECKs hold in the database", () => {
    const c = `c_mc_${n()}`
    client(c)
    const r = `r_${n()}`
    check("clientId", c, r, "PEP", "POSSIBLE_MATCH", `"triggeredById"|'${admin}'`)
    expect(run(`UPDATE "ScreeningCheck" SET decision = 'FALSE_POSITIVE', "decisionReason" = 'Different date of birth on the list.', "reviewedById" = '${admin}', "reviewedAt" = now() WHERE id = '${r}_PEP'`).output)
      .toContain("ScreeningCheck_maker_checker")
    expect(run(`INSERT INTO "ScreeningCheck" ("id", "tenantId", "runId", "trigger", "provider", "type", "result", "subjectFingerprint") VALUES ('nosub_${n()}', '${t}', 'x', 'MANUAL', 'simulated', 'PEP', 'CLEAR', 'fp')`).output)
      .toContain("ScreeningCheck_one_subject")
    const str = `str_mc_${n()}`
    sql(`INSERT INTO "SuspiciousReportCase" ("id", "tenantId", "reference", "kind", "clientId", "grounds", "raisedById", "updatedAt")
      VALUES ('${str}', '${t}', 'STR-${str}', 'SUSPICIOUS_TRANSACTION', '${c}', 'Cash deposits just under the threshold on three days.', '${admin}', now())`)
    expect(run(`UPDATE "SuspiciousReportCase" SET status = 'CLOSED_NO_REPORT', "assessmentNote" = 'Explained by a salary advance.', "assessedById" = '${admin}', "assessedAt" = now(), "closedAt" = now() WHERE id = '${str}'`).output)
      .toContain("SuspiciousReportCase_maker_checker")
    const rmcp = `rmcp_mc_${n()}`
    sql(`INSERT INTO "RmcpDocument" ("id", "tenantId", "version", "title", "fileName", "mimeType", "storagePath", "sha256", "fileSize", "uploadedById", "reviewDueAt")
      VALUES ('${rmcp}', '${t}', 1, 'RMCP', 'rmcp.pdf', 'application/pdf', '/tmp/none.pdf', '${"a".repeat(64)}', 10, '${admin}', '2027-10-14')`)
    expect(run(`UPDATE "RmcpDocument" SET "approvedById" = '${admin}', "approvedAt" = now() WHERE id = '${rmcp}'`).output).toContain("RmcpDocument_maker_checker")
  })
})
