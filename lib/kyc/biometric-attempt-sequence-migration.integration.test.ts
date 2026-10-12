/**
 * Behavioural proof for the biometric-attempt sequence and the composite-KYC
 * guards on Client and ClientDocument.
 *
 * Run only against a throwaway PostgreSQL database migrated with the baseline:
 *
 *   RUN_BIOMETRIC_SEQUENCE_MIGRATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/biometric-attempt-sequence-migration.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { beforeAll, describe, expect, it } from "vitest"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"

const RUN = process.env.RUN_BIOMETRIC_SEQUENCE_MIGRATION_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

function psqlDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for the biometric sequence migration test")
  }
  const parsed = new URL(databaseUrl)
  parsed.searchParams.delete("schema")
  return parsed.toString()
}

function sql(value: string): string {
  return execFileSync(
    "psql",
    ["--no-psqlrc", "--dbname", psqlDatabaseUrl(), "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", value],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim()
}

suite("biometric attempt sequence migration", () => {
  const tenantId = `tenant_biometric_migration_${token}`
  const clientId = `client_biometric_migration_${token}`
  const tiedAt = "2026-07-23 01:00:00+00"
  const firstRankedId = `aa_ranked_first_${token}`
  const secondRankedId = `zz_ranked_second_${token}`
  const rollingWriterId = `rolling_writer_${token}`
  const validSelfieId = `valid_selfie_${token}`
  const staleWriterSelfieId = `stale_writer_selfie_${token}`
  const orphanVerifiedClientId = `orphan_verified_client_${token}`
  const legacyFalseApprovalAuditId = `legacy_false_approval_${token}`
  const validSubjectFingerprint = biometricSubjectFingerprint({
    id: clientId,
    idNumber: `BIO-${token}`,
    firstName: "Synthetic",
    lastName: "Migration",
    dateOfBirth: null,
  })

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt")
      VALUES (
        '${tenantId}', 'biometric-migration-${token}',
        'Biometric migration test', CURRENT_TIMESTAMP
      );

      INSERT INTO "Client" (
        "id", "tenantId", "reference", "idNumber", "firstName", "lastName",
        "email", "phone", "kycStatus", "updatedAt"
      ) VALUES (
        '${clientId}', '${tenantId}', 'CLI-BIO-${token}', 'BIO-${token}',
        'Synthetic', 'Migration', 'biometric-${token}@test.invalid',
        '+27820000022', 'PENDING', CURRENT_TIMESTAMP
      );

      INSERT INTO "Client" (
        "id", "tenantId", "reference", "idNumber", "firstName", "lastName",
        "email", "phone", "kycStatus", "updatedAt"
      ) VALUES (
        '${orphanVerifiedClientId}', '${tenantId}', 'CLI-ORPHAN-${token}',
        'ORPHAN-${token}', 'Synthetic', 'Orphan',
        'orphan-${token}@test.invalid', '+27820000023', 'PENDING',
        CURRENT_TIMESTAMP
      );

      -- Two earlier attempts at the same timestamp, written without an
      -- explicit sequence, so the database numbers them 1 and 2.
      INSERT INTO "ClientDocument" (
        "id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "createdAt"
      ) VALUES (
        '${firstRankedId}', '${tenantId}', '${clientId}', 'SELFIE', '',
        'first-ranked.jpg', TIMESTAMPTZ '${tiedAt}'
      );
      INSERT INTO "ClientDocument" (
        "id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "createdAt"
      ) VALUES (
        '${secondRankedId}', '${tenantId}', '${clientId}', 'SELFIE', '',
        'second-ranked.jpg', TIMESTAMPTZ '${tiedAt}'
      );
    `)
  })

  it("assigns a sequence to an old-writer insert that omits the new column", () => {
    sql(`
      INSERT INTO "ClientDocument" (
        "id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "createdAt"
      ) VALUES (
        '${rollingWriterId}', '${tenantId}', '${clientId}', 'SELFIE', '',
        'rolling-writer.jpg', CURRENT_TIMESTAMP
      );
    `)

    expect(sql(`
      SELECT "biometricAttemptSequence"::text
      FROM "ClientDocument"
      WHERE "id" = '${rollingWriterId}';
    `)).toBe("3")
  })

  it("prevents a writer from changing established selfie chronology", () => {
    expect(() => sql(`
      UPDATE "ClientDocument"
      SET "biometricAttemptSequence" = 99
      WHERE "id" = '${firstRankedId}';
    `)).toThrow()

    expect(sql(`
      SELECT "biometricAttemptSequence"::text
      FROM "ClientDocument"
      WHERE "id" = '${firstRankedId}';
    `)).toBe("1")
  })

  it("fences rolling old writers from restoring or retaining stale composite KYC", () => {
    sql(`
      INSERT INTO "ClientDocument" (
        "id", "tenantId", "clientId", "docType", "fileUrl", "fileName",
        "verified", "verifiedAt", "createdAt", "contentSha256"
      ) VALUES
        ('core_id_${token}', '${tenantId}', '${clientId}', 'ID_COPY', '', 'id.pdf', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${"c".repeat(64)}'),
        ('core_address_${token}', '${tenantId}', '${clientId}', 'PROOF_OF_ADDRESS', '', 'address.pdf', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL),
        ('core_payslip_${token}', '${tenantId}', '${clientId}', 'PAYSLIP', '', 'payslip.pdf', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL),
        ('core_bank_${token}', '${tenantId}', '${clientId}', 'BANK_STATEMENT', '', 'bank.pdf', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL);

      -- This intentionally omits biometricAttemptSequence, as an old binary
      -- would, but carries the complete evidence contract used by the guard.
      INSERT INTO "ClientDocument" (
        "id", "tenantId", "clientId", "docType", "fileUrl", "fileName",
        "verified", "verifiedAt", "extractionStatus", "extractionResult",
        "validationMismatch", "validationScore", "biometricMatchScore",
        "biometricLiveness", "biometricVerifiedAt", "biometricResult", "createdAt"
      ) VALUES (
        '${validSelfieId}', '${tenantId}', '${clientId}', 'SELFIE', '',
        'valid-selfie.jpg', true, CURRENT_TIMESTAMP, 'done',
        '{"faceDetected":{"value":true},"facesCount":{"value":1},"isLive":{"value":true},"quality":{"value":"good"}}'::jsonb,
        false, 98, 98, 97, CURRENT_TIMESTAMP,
        '{"ok":true,"verified":true,"matchScore":98,"livenessScore":97,"provider":"vlm-face-match-v2","idPhotoKind":"photograph","idPhotoIsRealPhotograph":true,"idPhotoFaceDetected":true,"selfieIsRealPhotograph":true,"samePerson":"same","faceMatch":true,"matchConfidence":0.98,"livenessConfidence":0.97,"idDocumentId":"core_id_${token}","idDocumentSha256":"${"c".repeat(64)}","subjectFingerprint":"${validSubjectFingerprint}"}'::jsonb,
        CURRENT_TIMESTAMP
      );

      UPDATE "Client"
      SET
        "kycStatus" = 'VERIFIED',
        "kycVerifiedAt" = CURRENT_TIMESTAMP,
        "kycVerificationMethod" = 'SMILE_IDENTITY'
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)

    expect(sql(`
      SELECT "kycStatus"::text FROM "Client"
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toBe("VERIFIED")

    expect(() => sql(`
      -- A rolling old writer knows nothing about the biometric subject binding.
      -- It must not retain VERIFIED while changing an identity field.
      UPDATE "Client"
      SET "lastName" = 'Changed By Old Writer'
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toThrow()

    expect(sql(`
      SELECT concat_ws('|', "lastName", "kycStatus"::text)
      FROM "Client"
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toBe("Migration|VERIFIED")

    sql(`
      UPDATE "Client"
      SET
        "kycStatus" = 'PENDING',
        "kycVerifiedAt" = NULL,
        "kycVerificationMethod" = NULL
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)
    expect(() => sql(`
      -- A single old-writer statement must validate the proposed identity,
      -- rather than the pre-update Client row, before restoring VERIFIED.
      UPDATE "Client"
      SET
        "firstName" = 'Changed In Combined Update',
        "kycStatus" = 'VERIFIED',
        "kycVerifiedAt" = CURRENT_TIMESTAMP,
        "kycVerificationMethod" = 'SMILE_IDENTITY'
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toThrow()
    expect(sql(`
      SELECT concat_ws('|', "firstName", "kycStatus"::text)
      FROM "Client"
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toBe("Synthetic|PENDING")

    sql(`
      UPDATE "Client"
      SET
        "kycStatus" = 'VERIFIED',
        "kycVerifiedAt" = CURRENT_TIMESTAMP,
        "kycVerificationMethod" = 'SMILE_IDENTITY'
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)

    sql(`
      -- A two-request old-writer sequence must not bypass subject binding by
      -- lowering the cached status during the identity edit.
      UPDATE "Client"
      SET
        "lastName" = 'Changed In Two Steps',
        "kycStatus" = 'PENDING',
        "kycVerifiedAt" = NULL,
        "kycVerificationMethod" = NULL
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)
    expect(() => sql(`
      UPDATE "Client"
      SET
        "kycStatus" = 'VERIFIED',
        "kycVerifiedAt" = CURRENT_TIMESTAMP,
        "kycVerificationMethod" = 'SMILE_IDENTITY'
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toThrow()
    expect(sql(`
      SELECT concat_ws('|', "lastName", "kycStatus"::text)
      FROM "Client"
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toBe("Changed In Two Steps|PENDING")

    sql(`
      -- Restore the original subject so the following latest-attempt probe
      -- starts from a legitimately VERIFIED projection.
      UPDATE "Client"
      SET
        "lastName" = 'Migration',
        "kycStatus" = 'PENDING',
        "kycVerifiedAt" = NULL,
        "kycVerificationMethod" = NULL
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';

      UPDATE "Client"
      SET
        "kycStatus" = 'VERIFIED',
        "kycVerifiedAt" = CURRENT_TIMESTAMP,
        "kycVerificationMethod" = 'SMILE_IDENTITY'
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)

    sql(`
      -- The evidence trigger must evaluate the OLD scope after a core
      -- document is retyped away from that scope.
      UPDATE "ClientDocument"
      SET "docType" = 'OTHER'
      WHERE "id" = 'core_id_${token}';
    `)
    expect(sql(`
      SELECT "kycStatus"::text
      FROM "Client"
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toBe("PENDING")

    sql(`
      UPDATE "ClientDocument"
      SET "docType" = 'ID_COPY'
      WHERE "id" = 'core_id_${token}';

      UPDATE "Client"
      SET
        "kycStatus" = 'VERIFIED',
        "kycVerifiedAt" = CURRENT_TIMESTAMP,
        "kycVerificationMethod" = 'SMILE_IDENTITY'
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';

      -- Moving established core evidence must revoke the old owner even
      -- though the updated row now belongs to another Client.
      UPDATE "ClientDocument"
      SET "clientId" = '${orphanVerifiedClientId}'
      WHERE "id" = 'core_address_${token}';
    `)
    expect(sql(`
      SELECT "kycStatus"::text
      FROM "Client"
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toBe("PENDING")
    expect(sql(`
      SELECT count(*)::text
      FROM "AuditLog"
      WHERE "tenantId" = '${tenantId}'
        AND "entityId" = '${clientId}'
        AND "action" = 'KYC_STATUS_CHANGED'
        AND "newValue" ->> 'databaseEnforced' = 'true'
        AND "newValue" ->> 'evidenceScope' = 'OLD'
        AND "newValue" ->> 'documentId'
          IN ('core_id_${token}', 'core_address_${token}');
    `)).toBe("2")

    sql(`
      UPDATE "ClientDocument"
      SET "clientId" = '${clientId}'
      WHERE "id" = 'core_address_${token}';

      UPDATE "Client"
      SET
        "kycStatus" = 'VERIFIED',
        "kycVerifiedAt" = CURRENT_TIMESTAMP,
        "kycVerificationMethod" = 'SMILE_IDENTITY'
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)

    sql(`
      -- A rolling old writer can still omit the new sequence and provenance
      -- fields. The new latest attempt must immediately revoke cached KYC.
      INSERT INTO "ClientDocument" (
        "id", "tenantId", "clientId", "docType", "fileUrl", "fileName",
        "verified", "verifiedAt", "extractionStatus", "extractionResult",
        "validationMismatch", "validationScore", "biometricMatchScore",
        "biometricLiveness", "biometricVerifiedAt", "biometricResult", "createdAt"
      ) VALUES (
        '${staleWriterSelfieId}', '${tenantId}', '${clientId}', 'SELFIE', '',
        'stale-writer-selfie.jpg', true, CURRENT_TIMESTAMP, 'done',
        '{"faceDetected":{"value":true},"facesCount":{"value":1},"isLive":{"value":true},"quality":{"value":"good"}}'::jsonb,
        false, 98, 98, 97, CURRENT_TIMESTAMP,
        '{"ok":true,"verified":true,"matchScore":98,"livenessScore":97}'::jsonb,
        CURRENT_TIMESTAMP
      );
    `)

    expect(sql(`
      SELECT "kycStatus"::text FROM "Client"
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toBe("PENDING")

    expect(() => sql(`
      UPDATE "Client"
      SET "kycStatus" = 'VERIFIED', "kycVerifiedAt" = CURRENT_TIMESTAMP
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toThrow()

    expect(sql(`
      SELECT count(*)::text
      FROM "AuditLog"
      WHERE "tenantId" = '${tenantId}'
        AND "entityId" = '${clientId}'
        AND "action" = 'KYC_STATUS_CHANGED'
        AND "newValue" ->> 'documentId' = '${staleWriterSelfieId}'
        AND "newValue" ->> 'databaseEnforced' = 'true';
    `)).toBe("1")
  })

  it("keeps a manual rejection durable until an explicitly evidenced resolution", () => {
    sql(`
      UPDATE "Client"
      SET
        "kycManualRejectionActive" = true,
        "kycManualRejectionAt" = CURRENT_TIMESTAMP,
        "kycManualRejectionById" = 'staff-manual-rejector',
        "kycManualRejectionReason" = 'Identity particulars require manual investigation'
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)

    expect(sql(`
      SELECT concat_ws(
        '|', "kycStatus"::text, "kycManualRejectionActive"::text,
        "kycVerifiedAt" IS NULL, "kycVerificationMethod" IS NULL
      )
      FROM "Client"
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toBe("FAILED|true|t|t")

    expect(() => sql(`
      -- The old handler selected KYC_APPROVED from its request, not the
      -- returned row. Abort the whole legacy update-plus-audit transaction so
      -- it cannot commit a false approval event while the hold stays FAILED.
      BEGIN;
      UPDATE "Client"
      SET "kycStatus" = 'VERIFIED', "kycVerifiedAt" = CURRENT_TIMESTAMP
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
      INSERT INTO "AuditLog" (
        "id", "tenantId", "userEmail", "action", "entity", "entityId",
        "newValue", "createdAt"
      ) VALUES (
        '${legacyFalseApprovalAuditId}', '${tenantId}',
        'rolling-old-writer@test.invalid', 'KYC_APPROVED', 'Client',
        '${clientId}', '{"kycStatus":"FAILED","manualOverride":true}'::jsonb,
        CURRENT_TIMESTAMP
      );
      COMMIT;
    `)).toThrow()
    expect(sql(`
      SELECT concat_ws('|', "kycStatus"::text, "kycManualRejectionActive"::text)
      FROM "Client"
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toBe("FAILED|true")
    expect(sql(`
      SELECT COUNT(*)::text
      FROM "AuditLog"
      WHERE "id" = '${legacyFalseApprovalAuditId}'
        AND "action" = 'KYC_APPROVED';
    `)).toBe("0")

    expect(() => sql(`
      UPDATE "Client"
      SET "kycManualRejectionActive" = false
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toThrow()

    sql(`
      UPDATE "Client"
      SET
        "kycStatus" = 'PENDING',
        "kycManualRejectionActive" = false,
        "kycManualRejectionResolvedAt" = CURRENT_TIMESTAMP,
        "kycManualRejectionResolvedById" = 'staff-manual-resolver',
        "kycManualRejectionResolutionReason" =
          'Investigation completed; collect fresh current evidence'
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)
    expect(sql(`
      SELECT concat_ws(
        '|', "kycStatus"::text, "kycManualRejectionActive"::text,
        "kycManualRejectionResolvedById"
      )
      FROM "Client"
      WHERE "id" = '${clientId}' AND "tenantId" = '${tenantId}';
    `)).toBe("PENDING|false|staff-manual-resolver")
  })

  it("uses the explicitly mapped PostgreSQL-safe biometric ordering index", () => {
    expect(sql(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'ClientDocument'
        AND indexname = 'ClientDocument_biometric_attempt_order_idx';
    `)).toBe("ClientDocument_biometric_attempt_order_idx")
  })
})
