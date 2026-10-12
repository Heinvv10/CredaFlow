/**
 * Upgrade proof for migration 20261011080000_face_match_v3_evidence: a client
 * VERIFIED on v2 selfie evidence before the migration is demoted by it (with
 * an audit row) instead of being left unwritable by Client_enforce_composite_kyc,
 * and its v2 selfie is un-verified so the in-person route opens: the same
 * mechanism the v2 migration applied to v1. v3 evidence written before the
 * migration (which the v2 rule could not yet accept) verifies after it.
 * Clients verified in person or by a manual exception are left alone.
 *
 * Self-contained: creates its own throwaway database next to DATABASE_URL's,
 * applies the migrations BEFORE this one, seeds, applies this one, and drops
 * the database. The role in DATABASE_URL therefore needs CREATEDB.
 *
 *   RUN_FACE_MATCH_V3_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/face-match-v3-migration.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readdirSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import { PASSING_FACE_MODEL_EVIDENCE } from "@/lib/kyc/face-model/evidence.test-helpers"
import {
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_VERSION,
} from "@/lib/kyc/in-person-verification"
import { MANUAL_KYC_EXCEPTION_KIND, MANUAL_KYC_EXCEPTION_VERSION } from "@/lib/kyc/manual-exception"

const RUN = process.env.RUN_FACE_MATCH_V3_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const MIGRATION = "20261011080000_face_match_v3_evidence"
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations")
const NOT_VERIFIED = "Client KYC cannot be VERIFIED without current composite evidence"
const name = `fm_v3_mig_${randomBytes(6).toString("hex")}`

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
const v3Pass = { ...v2Pass, provider: "vlm-face-match-v3", faceModel: PASSING_FACE_MODEL_EVIDENCE }
const v1Pass = { ok: true, verified: true, provider: "vlm-face-match-v1", matchScore: 95, livenessScore: 97, faceMatch: true }
const [ID_SHA, SELFIE_SHA] = ["a".repeat(64), "e".repeat(64)]
const passedExtraction = '{"faceDetected":{"value":true},"facesCount":{"value":1},"isLive":{"value":true},"quality":{"value":"good"}}'
// TIMESTAMP(3) and its approvedAt rendering, as the evidence functions compare them.
const [APPROVED_AT, APPROVED_AT_ISO] = ["2026-10-10 12:00:00.000", "2026-10-10T12:00:00.000Z"]

const subjectOf = (label: string) => ({
  id: `client_${label}`, idNumber: `FMV3MIG-${label}`, firstName: "Synthetic", lastName: "Upgrade", dateOfBirth: null,
})
const fingerprintOf = (label: string) => biometricSubjectFingerprint(subjectOf(label))

/** A PENDING client with four verified core documents (the ID hashed). */
function seedClient(label: string) {
  const { id: clientId, idNumber } = subjectOf(label)
  const core = ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"]
    .map((docType) => `('core_${label}_${docType}', 'tenant_fm_v3_mig', '${clientId}', '${docType}', '', 'core.pdf', true, CURRENT_TIMESTAMP, '${ID_SHA}')`)
    .join(",\n")
  sql(`
    INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
    VALUES ('${clientId}', 'tenant_fm_v3_mig', 'CLI-${label}', '${idNumber}', 'Synthetic', 'Upgrade',
      '${label}@test.invalid', '+27820000077', CURRENT_TIMESTAMP);
    INSERT INTO "ClientDocument" ("id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "verified", "verifiedAt", "contentSha256")
    VALUES ${core};
  `)
  return clientId
}

/** A selfie row that passed the biometric check on the given evidence. */
function seedPassedSelfie(label: string, selfieId: string, biometricResult: Record<string, unknown>) {
  const evidence = JSON.stringify({
    // Compared against the client's verified ID copy, unless the case says otherwise.
    idDocumentId: `core_${label}_ID_COPY`, idDocumentSha256: ID_SHA,
    ...biometricResult, subjectFingerprint: fingerprintOf(label),
  })
  sql(`
    INSERT INTO "ClientDocument" (
      "id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "verified", "verifiedAt",
      "extractionStatus", "extractionResult", "validationMismatch", "validationScore",
      "biometricMatchScore", "biometricLiveness", "biometricVerifiedAt", "biometricResult", "verificationNote"
    ) VALUES (
      '${selfieId}', 'tenant_fm_v3_mig', 'client_${label}', 'SELFIE', '', 'selfie.jpg', true, CURRENT_TIMESTAMP,
      'done', '${passedExtraction}'::jsonb, false, 95, 95, 97, CURRENT_TIMESTAMP, '${evidence}'::jsonb,
      'Automatically verified by VLM face match against the ID document photograph'
    );
  `)
}

function setVerified(clientId: string, method: "BIOMETRIC" | "PHYSICAL") {
  sql(`UPDATE "Client" SET "kycStatus" = 'VERIFIED', "kycVerifiedAt" = CURRENT_TIMESTAMP,
    "kycVerifiedById" = ${method === "PHYSICAL" ? "'reviewer-synthetic'" : "NULL"},
    "kycVerificationMethod" = '${method}' WHERE "id" = '${clientId}';`)
}

function seedKycException(label: string, data: Record<string, unknown>) {
  const record = JSON.stringify({
    clientId: `client_${label}`,
    subjectFingerprint: fingerprintOf(label),
    approvedAt: APPROVED_AT_ISO, approvedById: "reviewer-synthetic", approvedByEmail: "reviewer@test.invalid",
    ...data,
  })
  sql(`INSERT INTO "ComplianceRecord" ("id", "tenantId", "type", "referenceId", "status", "completedAt", "data", "updatedAt")
    VALUES ('exception_${label}_${randomBytes(4).toString("hex")}', 'tenant_fm_v3_mig', 'KYC_EXCEPTION', 'client_${label}',
      'COMPLETED', '${APPROVED_AT}', '${record}'::jsonb, CURRENT_TIMESTAMP);`)
}

const seedInPersonRecord = (label: string) => seedKycException(label, {
  kind: IN_PERSON_KYC_VERIFICATION_KIND, version: IN_PERSON_KYC_VERIFICATION_VERSION,
  idDocumentId: `core_${label}_ID_COPY`, idDocumentSha256: ID_SHA, method: "IN_PERSON_BRANCH",
  note: "Synthetic client attended a branch; face matched the ID photo.",
})

/** A client VERIFIED (BIOMETRIC) on four core documents and one passing selfie. */
function seedVerifiedClient(label: string, biometricResult: Record<string, unknown>) {
  const clientId = seedClient(label)
  seedPassedSelfie(label, `selfie_${label}`, biometricResult)
  setVerified(clientId, "BIOMETRIC")
  return clientId
}

/** VERIFIED in person: no selfie at all. */
function seedInPersonVerifiedClient(label: string) {
  const clientId = seedClient(label)
  seedInPersonRecord(label)
  setVerified(clientId, "PHYSICAL")
  return clientId
}

/**
 * VERIFIED with an in-person attestation recorded first and a v2 selfie that
 * passed afterwards: the attestation counts once that selfie is un-verified.
 */
function seedInPersonThenV2Client(label: string) {
  const clientId = seedClient(label)
  seedInPersonRecord(label)
  seedPassedSelfie(label, `selfie_${label}`, v2Pass)
  setVerified(clientId, "BIOMETRIC")
  return clientId
}

/** VERIFIED by a senior exception over a failed latest selfie; an older v2 selfie had passed. */
function seedExceptionVerifiedClient(label: string) {
  const clientId = seedClient(label)
  seedPassedSelfie(label, `selfie_${label}_older`, v2Pass)
  sql(`INSERT INTO "ClientDocument" ("id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "verified",
      "contentSha256", "extractionStatus", "validationMismatch", "biometricResult")
    VALUES ('selfie_${label}', 'tenant_fm_v3_mig', '${clientId}', 'SELFIE', '', 'selfie.jpg', false,
      '${SELFIE_SHA}', 'failed', true, '{"biometricFailureReason":"face_not_detected"}'::jsonb);`)
  seedKycException(label, {
    kind: MANUAL_KYC_EXCEPTION_KIND, version: MANUAL_KYC_EXCEPTION_VERSION,
    documentId: `selfie_${label}`, documentSha256: SELFIE_SHA, biometricFailureReason: "face_not_detected",
    reason: "Synthetic integration exception after a controlled failed biometric attempt.",
    supportingEvidence: "Four verified synthetic core documents and the exact failed selfie were reviewed.",
  })
  setVerified(clientId, "PHYSICAL")
  return clientId
}

const migrationAudits = (entityId: string) => sql(`SELECT count(*) FROM "AuditLog"
  WHERE "entityId" = '${entityId}' AND "id" LIKE 'kyc-face-match-v3-%';`)

suite("face match v3 migration on a database verified under v2", () => {
  let v2ClientId = ""
  let v3ClientId = ""
  let inPersonClientId = ""
  let exceptionClientId = ""
  let inPersonV2ClientId = ""
  let clashAbortedMigration = false
  let statusAfterClash = ""

  beforeAll(() => {
    psql(databaseUrl(), ["-c", `CREATE DATABASE "${name}"`])
    const earlier = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < MIGRATION)
      .map((entry) => entry.name)
      .sort()
    for (const dir of earlier) applyMigration(dir)
    sql(`INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt")
      VALUES ('tenant_fm_v3_mig', 'fm-v3-mig', 'Face match v3 upgrade', CURRENT_TIMESTAMP);`)
    // Under the v2 rule: a client VERIFIED on v2 evidence.
    v2ClientId = seedVerifiedClient("v2", v2Pass)
    // v3 evidence the v2 rule cannot accept yet: the selfie row is verified,
    // the client is not.
    v3ClientId = seedClient("v3")
    seedPassedSelfie("v3", "selfie_v3", v3Pass)
    // Verified selfie rows no client is VERIFIED on: a v1 row an old writer
    // left behind, and a v3-tagged row whose face model did not confirm.
    seedClient("v1row")
    seedPassedSelfie("v1row", "selfie_v1row", v1Pass)
    seedClient("v3bad")
    seedPassedSelfie("v3bad", "selfie_v3bad", { ...v3Pass, faceModel: { ...PASSING_FACE_MODEL_EVIDENCE, similarity: 0.2 } })
    inPersonClientId = seedInPersonVerifiedClient("inperson")
    exceptionClientId = seedExceptionVerifiedClient("exception")
    inPersonV2ClientId = seedInPersonThenV2Client("ipv2")
    // A pre-existing row with a demotion audit id must abort the whole
    // migration, not demote that client silently. Rolled back as one unit.
    try {
      psql(databaseUrl(name), [
        "--single-transaction",
        "-c", `INSERT INTO "AuditLog" ("id", "action", "entity") VALUES ('kyc-face-match-v3-reset-${v2ClientId}', 'CLASH', 'Client');`,
        "-f", path.join(MIGRATIONS_DIR, MIGRATION, "migration.sql"),
      ])
    } catch (error) {
      clashAbortedMigration = String((error as { stderr?: unknown }).stderr).includes("duplicate key")
    }
    statusAfterClash = sql(`SELECT "kycStatus" FROM "Client" WHERE "id" = '${v2ClientId}';`)
    applyMigration(MIGRATION)
  }, 120_000)

  afterAll(() => {
    psql(databaseUrl(), ["-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`])
  })

  it("demotes the client verified on v2 evidence to PENDING and clears provenance", () => {
    expect(sql(`SELECT concat_ws('|', "kycStatus", "kycVerifiedAt", "kycVerifiedById", "kycVerificationMethod")
      FROM "Client" WHERE "id" = '${v2ClientId}';`)).toBe("PENDING")
  })

  it("writes one system KYC_STATUS_CHANGED audit row for the demotion", () => {
    const rows = sql(`SELECT json_build_object('userId', "userId", 'userEmail', "userEmail", 'action', "action",
        'entity', "entity", 'old', "oldValue" ->> 'kycStatus', 'new', "newValue" ->> 'kycStatus',
        'reason', "newValue" ->> 'reason', 'migration', "newValue" ->> 'migration')
      FROM "AuditLog" WHERE "entityId" = '${v2ClientId}' AND "id" LIKE 'kyc-face-match-v3-reset-%';`)
    expect(rows.split("\n").map((row) => JSON.parse(row))).toEqual([{
      userId: null,
      userEmail: "migration@face-match-v3-evidence",
      action: "KYC_STATUS_CHANGED",
      entity: "Client",
      old: "VERIFIED",
      new: "PENDING",
      reason: "face_match_v3_evidence_required",
      migration: MIGRATION,
    }])
  })

  it("leaves the demoted client writable by an ordinary update", () => {
    sql(`UPDATE "Client" SET "phone" = '+27820000078', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '${v2ClientId}';`)
    expect(sql(`SELECT "phone" FROM "Client" WHERE "id" = '${v2ClientId}';`)).toBe("+27820000078")
  })

  it("refuses to re-verify the demoted client on its v2 evidence", () => {
    expect(() => sql(`UPDATE "Client" SET "kycStatus" = 'VERIFIED', "kycVerifiedAt" = CURRENT_TIMESTAMP,
      "kycVerificationMethod" = 'BIOMETRIC' WHERE "id" = '${v2ClientId}';`)).toThrow(NOT_VERIFIED)
  })

  it("aborts, demoting nobody, when a demotion audit id already exists", () => {
    expect(clashAbortedMigration).toBe(true)
    expect(statusAfterClash).toBe("VERIFIED")
  })

  it("un-verifies the demoted client's v2 selfie and keeps its evidence JSON", () => {
    expect(JSON.parse(sql(`SELECT json_build_object('verified', "verified", 'verifiedAt', "verifiedAt",
        'verifiedById', "verifiedById", 'biometricVerifiedAt', "biometricVerifiedAt",
        'extractionStatus', "extractionStatus", 'extractionResult', "extractionResult",
        'biometricResult', "biometricResult", 'verificationNote', "verificationNote")
      FROM "ClientDocument" WHERE "id" = 'selfie_v2';`))).toEqual({
      verified: false,
      verifiedAt: null,
      verifiedById: null,
      biometricVerifiedAt: null,
      extractionStatus: "done",
      extractionResult: JSON.parse(passedExtraction),
      biometricResult: {
        idDocumentId: "core_v2_ID_COPY", idDocumentSha256: ID_SHA, ...v2Pass, subjectFingerprint: fingerprintOf("v2"),
      },
      verificationNote: "Selfie evidence predates face match v3; repeat biometric or in-person verification.",
    })
  })

  it.each(["selfie_v2", "selfie_v1row", "selfie_v3bad"])("writes one system audit row for un-verifying %s", (id) => {
    expect(sql(`SELECT "verified" FROM "ClientDocument" WHERE "id" = '${id}';`)).toBe("f")
    expect(JSON.parse(sql(`SELECT json_build_object('action', "action", 'entity', "entity",
        'oldVerified', "oldValue" -> 'verified', 'newVerified', "newValue" -> 'verified', 'reason', "newValue" ->> 'reason')
      FROM "AuditLog" WHERE "id" = 'kyc-face-match-v3-selfie-reset-${id}';`))).toEqual({
      action: "KYC_REJECTED", entity: "ClientDocument", oldVerified: true, newVerified: false,
      reason: "face_match_v3_evidence_required",
    })
  })

  it("lets the demoted client complete the in-person route to VERIFIED", () => {
    seedInPersonRecord("v2")
    setVerified(v2ClientId, "PHYSICAL")
    expect(sql(`SELECT concat_ws('|', "kycStatus", "kycVerificationMethod") FROM "Client"
      WHERE "id" = '${v2ClientId}';`)).toBe("VERIFIED|PHYSICAL")
  })

  it("keeps a v3 selfie verified and unaudited, and verifies its client on it", () => {
    expect(sql(`SELECT concat_ws('|', "verified", "biometricVerifiedAt" IS NOT NULL) FROM "ClientDocument"
      WHERE "id" = 'selfie_v3';`)).toBe("t|t")
    expect(migrationAudits("selfie_v3")).toBe("0")
    setVerified(v3ClientId, "BIOMETRIC")
    expect(sql(`SELECT "kycStatus" FROM "Client" WHERE "id" = '${v3ClientId}';`)).toBe("VERIFIED")
  })

  it("leaves a client verified in person VERIFIED and unaudited", () => {
    expect(sql(`SELECT "kycStatus" FROM "Client" WHERE "id" = '${inPersonClientId}';`)).toBe("VERIFIED")
    expect(migrationAudits(inPersonClientId)).toBe("0")
  })

  // Step 4 runs before step 5, as in the v2 migration: un-verified first, the
  // v2 selfie stops blocking the attestation, so this client is not demoted.
  it("keeps a client with an in-person attestation VERIFIED once its passed v2 selfie is un-verified", () => {
    expect(sql(`SELECT "kycStatus" FROM "Client" WHERE "id" = '${inPersonV2ClientId}';`)).toBe("VERIFIED")
    expect(sql(`SELECT count(*) FROM "AuditLog" WHERE "entityId" = '${inPersonV2ClientId}';`)).toBe("0")
    expect(sql(`SELECT "verified" FROM "ClientDocument" WHERE "id" = 'selfie_ipv2';`)).toBe("f")
    expect(migrationAudits("selfie_ipv2")).toBe("1")
  })

  // Un-verifying the v2 selfie in step 4 lets ClientDocument_revoke_stale_composite_kyc
  // demote this client first; step 5 still writes this migration's row for it.
  it("writes the migration's audit row for a client the revoke trigger demoted", () => {
    expect(sql(`SELECT count(*) FROM "AuditLog" WHERE "entityId" = '${v2ClientId}'
      AND "userEmail" = 'database@composite-kyc-guard';`)).toBe("1")
    expect(sql(`SELECT count(*) FROM "AuditLog" WHERE "id" = 'kyc-face-match-v3-reset-${v2ClientId}';`)).toBe("1")
  })

  it("leaves a client verified by a manual exception VERIFIED, though its older v2 selfie is un-verified", () => {
    expect(sql(`SELECT "kycStatus" FROM "Client" WHERE "id" = '${exceptionClientId}';`)).toBe("VERIFIED")
    expect(sql(`SELECT count(*) FROM "AuditLog" WHERE "entityId" = '${exceptionClientId}';`)).toBe("0")
    expect(sql(`SELECT "verified" FROM "ClientDocument" WHERE "id" = 'selfie_exception_older';`)).toBe("f")
    expect(migrationAudits("selfie_exception_older")).toBe("1")
  })
})
