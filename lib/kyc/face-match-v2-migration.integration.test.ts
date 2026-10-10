/**
 * Upgrade proof for migration 20261010150000_face_match_v2_evidence: a client
 * VERIFIED on v1 selfie evidence before the migration is demoted by it (with
 * an audit row) instead of being left unwritable by Client_enforce_composite_kyc.
 *
 * Self-contained: creates its own throwaway database next to DATABASE_URL's,
 * applies the migrations BEFORE this one, seeds, applies this one, and drops
 * the database. The role in DATABASE_URL therefore needs CREATEDB.
 *
 *   RUN_FACE_MATCH_V2_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/face-match-v2-migration.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readdirSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"

const RUN = process.env.RUN_FACE_MATCH_V2_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const MIGRATION = "20261010150000_face_match_v2_evidence"
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations")
const NOT_VERIFIED = "Client KYC cannot be VERIFIED without current composite evidence"
const name = `fm_v2_mig_${randomBytes(6).toString("hex")}`

function databaseUrl(database?: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.searchParams.delete("schema")
  if (database) url.pathname = `/${database}`
  return url.toString()
}

function psql(url: string, args: string[]): string {
  return execFileSync(
    "psql",
    ["--no-psqlrc", "-X", "--dbname", url, "-v", "ON_ERROR_STOP=1", "-At", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim()
}

const sql = (value: string) => psql(databaseUrl(name), ["-c", value])
// One transaction per migration file, as `prisma migrate deploy` applies it.
const applyMigration = (dir: string) =>
  psql(databaseUrl(name), ["--single-transaction", "-f", path.join(MIGRATIONS_DIR, dir, "migration.sql")])

const v2Pass = {
  ok: true,
  verified: true,
  provider: "vlm-face-match-v2",
  matchScore: 95,
  livenessScore: 97,
  matchConfidence: 0.95,
  livenessConfidence: 0.97,
  idPhotoKind: "photograph",
  idPhotoIsRealPhotograph: true,
  idPhotoFaceDetected: true,
  selfieIsRealPhotograph: true,
  samePerson: "same",
  faceMatch: true,
}
const v1Pass = { ok: true, verified: true, provider: "vlm-face-match-v1", matchScore: 95, livenessScore: 97, faceMatch: true }

/** A client VERIFIED (BIOMETRIC) on four core documents and one passing selfie. */
function seedVerifiedClient(label: string, biometricResult: Record<string, unknown>) {
  const clientId = `client_${label}`
  const subject = { id: clientId, idNumber: `FMV2MIG-${label}`, firstName: "Synthetic", lastName: "Upgrade", dateOfBirth: null }
  const evidence = JSON.stringify({ ...biometricResult, subjectFingerprint: biometricSubjectFingerprint(subject) })
  const core = ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"]
    .map((docType) => `('core_${label}_${docType}', 'tenant_fm_v2_mig', '${clientId}', '${docType}', '', 'core.pdf', true, CURRENT_TIMESTAMP)`)
    .join(",\n")
  sql(`
    INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
    VALUES ('${clientId}', 'tenant_fm_v2_mig', 'CLI-${label}', '${subject.idNumber}', 'Synthetic', 'Upgrade',
      '${label}@test.invalid', '+27820000077', CURRENT_TIMESTAMP);
    INSERT INTO "ClientDocument" ("id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "verified", "verifiedAt")
    VALUES ${core};
    INSERT INTO "ClientDocument" (
      "id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "verified", "verifiedAt",
      "extractionStatus", "extractionResult", "validationMismatch", "validationScore",
      "biometricMatchScore", "biometricLiveness", "biometricVerifiedAt", "biometricResult"
    ) VALUES (
      'selfie_${label}', 'tenant_fm_v2_mig', '${clientId}', 'SELFIE', '', 'selfie.jpg', true, CURRENT_TIMESTAMP,
      'done', '{"faceDetected":{"value":true},"facesCount":{"value":1},"isLive":{"value":true},"quality":{"value":"good"}}'::jsonb,
      false, 95, 95, 97, CURRENT_TIMESTAMP, '${evidence}'::jsonb
    );
    UPDATE "Client" SET "kycStatus" = 'VERIFIED', "kycVerifiedAt" = CURRENT_TIMESTAMP,
      "kycVerificationMethod" = 'BIOMETRIC' WHERE "id" = '${clientId}';
  `)
  return clientId
}

suite("face match v2 migration on a database verified under v1", () => {
  let v1ClientId = ""
  let v2ClientId = ""

  beforeAll(() => {
    psql(databaseUrl(), ["-c", `CREATE DATABASE "${name}"`])
    const earlier = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < MIGRATION)
      .map((entry) => entry.name)
      .sort()
    for (const dir of earlier) applyMigration(dir)
    sql(`INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt")
      VALUES ('tenant_fm_v2_mig', 'fm-v2-mig', 'Face match v2 upgrade', CURRENT_TIMESTAMP);`)
    v1ClientId = seedVerifiedClient("v1", v1Pass)
    v2ClientId = seedVerifiedClient("v2", v2Pass)
    applyMigration(MIGRATION)
  }, 120_000)

  afterAll(() => {
    psql(databaseUrl(), ["-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`])
  })

  it("demotes the client verified on v1 evidence to PENDING and clears provenance", () => {
    expect(sql(`SELECT concat_ws('|', "kycStatus", "kycVerifiedAt", "kycVerifiedById", "kycVerificationMethod")
      FROM "Client" WHERE "id" = '${v1ClientId}';`)).toBe("PENDING")
  })

  it("writes one system KYC_STATUS_CHANGED audit row for the demotion", () => {
    const rows = sql(`SELECT json_build_object('userId', "userId", 'userEmail', "userEmail", 'action', "action",
        'entity', "entity", 'old', "oldValue" ->> 'kycStatus', 'new', "newValue" ->> 'kycStatus',
        'reason', "newValue" ->> 'reason')
      FROM "AuditLog" WHERE "entityId" = '${v1ClientId}' AND "id" LIKE 'kyc-face-match-v2-reset-%';`)
    expect(rows.split("\n").map((row) => JSON.parse(row))).toEqual([{
      userId: null,
      userEmail: "migration@face-match-v2-evidence",
      action: "KYC_STATUS_CHANGED",
      entity: "Client",
      old: "VERIFIED",
      new: "PENDING",
      reason: "face_match_v2_evidence_required",
    }])
  })

  it("leaves the demoted client writable by an ordinary update", () => {
    sql(`UPDATE "Client" SET "phone" = '+27820000078', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '${v1ClientId}';`)
    expect(sql(`SELECT "phone" FROM "Client" WHERE "id" = '${v1ClientId}';`)).toBe("+27820000078")
  })

  it("refuses to re-verify the demoted client on its v1 evidence", () => {
    expect(() => sql(`UPDATE "Client" SET "kycStatus" = 'VERIFIED', "kycVerifiedAt" = CURRENT_TIMESTAMP,
      "kycVerificationMethod" = 'BIOMETRIC' WHERE "id" = '${v1ClientId}';`)).toThrow(NOT_VERIFIED)
  })

  it("keeps a client verified on v2 evidence VERIFIED, unaudited and writable", () => {
    expect(sql(`SELECT "kycStatus" FROM "Client" WHERE "id" = '${v2ClientId}';`)).toBe("VERIFIED")
    expect(sql(`SELECT count(*) FROM "AuditLog" WHERE "entityId" = '${v2ClientId}';`)).toBe("0")
    sql(`UPDATE "Client" SET "phone" = '+27820000079', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '${v2ClientId}';`)
  })
})
