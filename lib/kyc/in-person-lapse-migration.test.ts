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
    expect(codeLines(v2).filter((line) => !kept.has(line))).toEqual([])
  })

  it("adds the adverse-verdict-after rule on the latest attempt, the attested ID, and the C collation", () => {
    const lines = codeLines(latest)
    expect(lines).toEqual(expect.arrayContaining([
      `AND jsonb_typeof(verdict."biometricResult" -> 'verdictRecordedAt') = 'string'`,
      `~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$'`,
      `AND (verdict."biometricResult" ->> 'verdictRecordedAt') COLLATE "C" >`,
      `to_char(attestation."completedAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') COLLATE "C"`,
      `AND verdict."biometricResult" ->> 'idDocumentId' = id_document."id"`,
      `AND "face_verdict_is_adverse"(verdict."biometricResult")`,
    ]))
    expect(latest).toContain(`latest."biometricAttemptSequence" DESC`)
  })

  it("adds the unknown-outcome rule for ANY attempt created after the attestation", () => {
    const lines = codeLines(latest)
    expect(lines).toEqual(expect.arrayContaining([
      `AND unknown_outcome."biometricResult" ->> 'biometricFailureReason' =`,
      `'biometric_outcome_not_recorded'`,
      `AND unknown_outcome."createdAt" > attestation."completedAt"`,
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
