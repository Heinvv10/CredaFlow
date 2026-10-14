/**
 * Static proof for migration 20261011080000_face_match_v3_evidence: the v3
 * composite gate keeps every condition of the v2 one, and the SQL pins the
 * same models and threshold as the TypeScript gate. What the gate does when
 * it runs is proven against Postgres by face-match-v3-evidence.integration.test.ts.
 */
import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { baselineFunctionSql } from "@/lib/db-baseline.test-helpers"
import {
  FACE_MODELS,
  FACE_MODEL_DETECTOR_RUNTIME_SHA256,
  FACE_SIMILARITY_THRESHOLD,
  ID_MAX_FACE_COUNT,
  ID_SECOND_FACE_MAX_AREA_RATIO,
  ID_SECOND_FACE_MIN_AREA_RATIO,
  MAX_ALIGNED_CROP_SHARPNESS,
  MAX_INTER_OCULAR_PX,
  MIN_ALIGNED_CROP_SHARPNESS,
  MIN_INTER_OCULAR_PX,
  MIN_LANDMARK_GEOMETRY_MARGIN,
} from "@/lib/kyc/face-model/models"
import { VLM_FACE_MATCH_PROVIDER } from "@/lib/kyc/biometric-evidence"

const MIGRATIONS = path.join(__dirname, "..", "..", "prisma", "migrations")
const read = (dir: string) => fs.readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8")

/** One function's definition in one migration file. */
function functionIn(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  expect(start).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf("$function$;", start) + "$function$;".length)
}
const compositeIn = (sql: string) => functionIn(sql, "subject_has_composite_kyc")

/** Each non-comment line, trimmed: the conditions, as written. */
const codeLines = (sql: string) =>
  sql.split("\n").map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("--"))

describe("migration 20261011080000_face_match_v3_evidence", () => {
  const v2 = compositeIn(read("20261011060000_face_match_v2_evidence"))
  const v3 = baselineFunctionSql("subject_has_composite_kyc")

  it("is the newest definition of subject_has_composite_kyc", () => {
    expect(v3).toBe(compositeIn(read("20261011080000_face_match_v3_evidence")))
  })

  it("keeps every v2 condition except the provider tag", () => {
    const v3Lines = new Set(codeLines(v3))
    const dropped = codeLines(v2).filter((line) => !v3Lines.has(line))
    expect(dropped).toEqual(["AND selfie.\"biometricResult\" ->> 'provider' = 'vlm-face-match-v2'"])
  })

  it("requires the v3 tag the writer stamps and the face model's evidence", () => {
    expect(codeLines(v3)).toEqual(expect.arrayContaining([
      `AND selfie."biometricResult" ->> 'provider' = '${VLM_FACE_MATCH_PROVIDER}'`,
      `AND "face_model_evidence_holds"(selfie."biometricResult" -> 'faceModel')`,
    ]))
  })

  // Neither reads the provider tag, and v3 adds no failure reason. Migration
  // 20261014120000 later ADDED two lapse rules (in-person-lapse-migration.test.ts);
  // it must still hold every v2 condition.
  it("keeps every v2 condition of the in-person predicate", () => {
    const kept = new Set(codeLines(baselineFunctionSql("subject_has_in_person_kyc_verification")))
    const v2 = functionIn(read("20261011060000_face_match_v2_evidence"), "subject_has_in_person_kyc_verification")
    expect(codeLines(v2).filter((line) => !kept.has(line))).toEqual([])
  })

  it("keeps the manual exception predicate provider-agnostic while adding the clear-mismatch guard", () => {
    const manual = baselineFunctionSql("subject_has_manual_kyc_exception")
    expect(manual).not.toContain("'provider'")
    expect(manual).toContain("kyc_exception_selfie_is_clear_mismatch")
  })

  it("pins the same models, threshold and ghost-face ratio as the TypeScript gate", () => {
    const holds = baselineFunctionSql("face_model_evidence_holds")
    expect(holds).toContain(`p_evidence ->> 'detector' = '${FACE_MODELS.detector.name}'`)
    expect(holds).toContain(`p_evidence ->> 'detectorSha256' = '${FACE_MODELS.detector.sha256}'`)
    expect(holds).toContain(`p_evidence ->> 'detectorRuntimeSha256' = '${FACE_MODEL_DETECTOR_RUNTIME_SHA256}'`)
    expect(holds).toContain(`p_evidence ->> 'recognizer' = '${FACE_MODELS.recognizer.name}'`)
    expect(holds).toContain(`p_evidence ->> 'recognizerSha256' = '${FACE_MODELS.recognizer.sha256}'`)
    expect(holds).toContain(`p_evidence -> 'threshold' = '${FACE_SIMILARITY_THRESHOLD}'::jsonb`)
    expect(holds).toContain(`BETWEEN ${FACE_SIMILARITY_THRESHOLD} AND 1`)
    expect(holds).toContain(`::numeric <= ${ID_SECOND_FACE_MAX_AREA_RATIO}`)
    expect(holds).toContain(`'idSecondFaceAreaRatio')::numeric >= ${ID_SECOND_FACE_MIN_AREA_RATIO}`)
    expect(holds).toContain(`BETWEEN 2 AND ${ID_MAX_FACE_COUNT}`)
    expect(holds).toContain(`p_evidence -> 'idDetectPass' IN ('"fit640"'::jsonb, '"full"'::jsonb)`)
    for (const side of ["id", "selfie"]) {
      expect(holds).toContain(`'${side}InterOcularPx')::numeric BETWEEN ${MIN_INTER_OCULAR_PX} AND ${MAX_INTER_OCULAR_PX}`)
      expect(holds).toContain(`'${side}GeometryMargin')::numeric BETWEEN ${MIN_LANDMARK_GEOMETRY_MARGIN} AND 1`)
      expect(holds).toContain(`'${side}Sharpness')::numeric BETWEEN ${MIN_ALIGNED_CROP_SHARPNESS} AND ${MAX_ALIGNED_CROP_SHARPNESS}`)
    }
  })

  it("un-verifies stale selfies on the same v3 predicate the composite gate uses", () => {
    const sql = read("20261011080000_face_match_v3_evidence")
    const unverify = sql.slice(sql.indexOf("WITH stale_selfie AS"))
    expect(unverify).toContain(`selfie."biometricResult" ->> 'provider' = '${VLM_FACE_MATCH_PROVIDER}'`)
    expect(unverify).toContain(`AND "face_model_evidence_holds"(selfie."biometricResult" -> 'faceModel')`)
  })
})
