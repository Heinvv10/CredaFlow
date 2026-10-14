/**
 * Static proof for migration 20261014120000_in_person_lapse_on_adverse_verdict:
 * the in-person predicate keeps every v2 condition and adds exactly the two
 * lapse rules, and the SQL pins the same stamp format, reason and comparison
 * as the TypeScript derivation. What the predicate does when it runs is proven
 * against Postgres by in-person-lapse-parity.integration.test.ts.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { baselineFunctionSql } from "@/lib/db-baseline.test-helpers"
import { PRIOR_FAILED_ATTEMPT_CONDITIONS } from "@/lib/kyc/biometric-evidence"

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations")
const NEW_MIGRATION = "20261014120000_in_person_lapse_on_adverse_verdict"
const read = (dir: string) => fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8")

function functionIn(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf("$function$;", start) + "$function$;".length)
}
const codeLines = (sql: string) =>
  sql.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("--"))

describe(`migration ${NEW_MIGRATION}`, () => {
  const v2 = functionIn(read("20261011060000_face_match_v2_evidence"), "subject_has_in_person_kyc_verification")
  const latest = baselineFunctionSql("subject_has_in_person_kyc_verification")

  it("is the newest definition of the in-person predicate", () => {
    expect(latest).toBe(functionIn(read(NEW_MIGRATION), "subject_has_in_person_kyc_verification"))
  })

  it("keeps every v2 condition and only adds", () => {
    const kept = new Set(codeLines(latest))
    // Only the portrait-refusal reason test is reworded: it now reads the
    // worker's own reason too (the next test pins the new form).
    expect(codeLines(v2).filter((line) => !kept.has(line))).toEqual([
      `AND refused."biometricResult" ->> 'biometricFailureReason' =`,
      `'id_document_portrait_invalid'`,
    ])
  })

  it("adds the adverse-verdict-after rule over ANY attempt on the attested ID, with the C collation", () => {
    const lines = codeLines(latest)
    expect(lines).toEqual(expect.arrayContaining([
      `AND jsonb_typeof(verdict."biometricResult" -> 'verdictRecordedAt') = 'string'`,
      `~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'`,
      `AND (verdict."biometricResult" ->> 'verdictRecordedAt') COLLATE "C" >=`,
      `to_char(attestation."completedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') COLLATE "C"`,
      // Bound to the attested ID; a verdict naming no ID fails closed.
      `jsonb_typeof(verdict."biometricResult" -> 'idDocumentId') IS DISTINCT FROM 'string'`,
      `OR verdict."biometricResult" ->> 'idDocumentId' = id_document."id"`,
      `AND "face_verdict_is_adverse"(verdict."biometricResult")`,
    ]))
    // Not bound to the latest attempt: a benign-failing retake must not bury it.
    expect(latest).not.toContain(`latest."biometricAttemptSequence"`)
    expect(latest).not.toContain(`verdict."id" =`)
  })

  it("reads the worker's own ID-portrait refusal as well as the recorded reason", () => {
    expect(latest).toContain(`refused."biometricResult" ->> 'workerFailureReason'`)
    expect(latest).toContain(`AND 'id_document_portrait_invalid' IN (`)
  })

  it("filters both rules to the attempts of PRIOR_FAILED_ATTEMPT_CONDITIONS, as the TypeScript query does", () => {
    for (const alias of ["verdict", "unknown_outcome"]) {
      expect(latest).toContain(`${alias}."extractionStatus" IN ('failed', 'skipped', 'pending', 'processing')`)
      expect(latest).toContain(`OR ${alias}."verificationRejectedAt" IS NOT NULL`)
      expect(latest).toContain(`OR ${alias}."verificationRejectedById" IS NOT NULL`)
    }
    expect(PRIOR_FAILED_ATTEMPT_CONDITIONS.OR[0].extractionStatus.in).toEqual(["failed", "skipped", "pending", "processing"])
  })

  it("demotes every VERIFIED client the new predicate refuses, through the audited revoke function", () => {
    const sql = read(NEW_MIGRATION)
    const step = sql.slice(sql.indexOf('PERFORM "revoke_client_composite_kyc"('))
    expect(step).toContain("RAISE NOTICE")
    expect(step).toContain(`WHERE client."kycStatus" = 'VERIFIED'`)
    expect(step).toContain(`AND NOT "client_has_composite_kyc"(client."tenantId", client."id")`)
    // The header must not claim the migration is harmless to main's writers.
    expect(sql).not.toContain("rejects nothing main writes")
    expect(sql).toContain("REJECTS writes that main still makes")
  })

  it("adds the unknown-outcome rule for ANY attempt created after the attestation", () => {
    const lines = codeLines(latest)
    expect(lines).toEqual(expect.arrayContaining([
      `unknown_outcome."biometricResult" ->> 'biometricFailureReason' =`,
      `'biometric_outcome_not_recorded'`,
      `AND unknown_outcome."createdAt" >= attestation."completedAt"`,
      // The sweeper's marker survives a late answer that replaces the reason.
      `OR jsonb_typeof(unknown_outcome."biometricResult" -> 'sweptAt') = 'string'`,
    ]))
  })

  it("names the stamp format the TypeScript derivation and the writer use", () => {
    const ts = fs.readFileSync(path.join(__dirname, "in-person-verification.ts"), "utf8")
    expect(ts).toContain("/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/")
    expect(ts).toContain(`"biometric_outcome_not_recorded"`)
    const writer = fs.readFileSync(path.join(__dirname, "selfie-biometric.server.ts"), "utf8")
    expect(writer).toContain("verdictRecordedAt: completedAt.toISOString()")
  })

  it("defines face_verdict_is_adverse over the six answers adverseFaceVerdict reads", () => {
    const fn = baselineFunctionSql("face_verdict_is_adverse")
    for (const key of [
      "'samePerson'", "'faceMatch'", "'{faceModel,samePerson}'",
      "'{faceVerdict,samePerson}'", "'{faceVerdict,faceMatch}'", "'{faceVerdict,faceModelSamePerson}'",
    ]) expect(fn).toContain(key)
  })
})
