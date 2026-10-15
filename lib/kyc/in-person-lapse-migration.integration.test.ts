/**
 * Upgrade proof for migration 20261014120000_in_person_lapse_on_adverse_verdict.
 *
 * Main already records biometric_outcome_not_recorded on a failed outcome
 * write, so a client VERIFIED in person with such an attempt created after the
 * attestation exists on a database BEFORE this migration. The new predicate
 * refuses it, and Client_enforce_composite_kyc would then raise on every
 * unrelated write to that client. The migration's data step demotes it first,
 * with an audit row. Clients the predicate still accepts are left alone.
 *
 * Self-contained: creates its own throwaway database next to DATABASE_URL's,
 * applies the migrations BEFORE this one, seeds, applies this one, and drops
 * the database. The role in DATABASE_URL therefore needs CREATEDB.
 *
 *   RUN_KYC_IN_PERSON_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/in-person-lapse-migration.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readdirSync } from "node:fs"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { biometricSubjectFingerprint } from "@/lib/kyc/biometric-evidence"
import {
  IN_PERSON_KYC_VERIFICATION_KIND,
  IN_PERSON_KYC_VERIFICATION_VERSION,
} from "@/lib/kyc/in-person-verification"

const RUN = process.env.RUN_KYC_IN_PERSON_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const MIGRATION = "20261014120000_in_person_lapse_on_adverse_verdict"
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations")
const NOT_VERIFIED = "Client KYC cannot be VERIFIED without current composite evidence"
const name = `ip_lapse_mig_${randomBytes(6).toString("hex")}`
const ID_SHA = "a".repeat(64)
const [APPROVED_AT, APPROVED_AT_ISO] = ["2026-10-10 12:00:00.000", "2026-10-10T12:00:00.000Z"]
const AFTER_ATTESTATION = "2026-10-11 09:00:00.000"

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
const applyMigration = (dir: string) =>
  psql(databaseUrl(name), ["--single-transaction", "-f", path.join(MIGRATIONS_DIR, dir, "migration.sql")])

const idOf = (label: string) => `client_${label}`
const fingerprintOf = (label: string) => biometricSubjectFingerprint({
  id: idOf(label), idNumber: `IPLAPSE-${label}`, firstName: "Synthetic", lastName: "Upgrade", dateOfBirth: null,
})

/** A client VERIFIED in person, with an optional selfie attempt created after the attestation. */
function seedVerifiedInPerson(label: string, laterAttempt: { status: string; result: Record<string, unknown> } | null) {
  const clientId = idOf(label)
  const core = ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"]
    .map((docType) => `('core_${label}_${docType}', 'tenant_ip_lapse', '${clientId}', '${docType}', '', 'core.pdf', true, CURRENT_TIMESTAMP, '${ID_SHA}')`)
    .join(",\n")
  const record = JSON.stringify({
    kind: IN_PERSON_KYC_VERIFICATION_KIND, version: IN_PERSON_KYC_VERIFICATION_VERSION, clientId,
    idDocumentId: `core_${label}_ID_COPY`, idDocumentSha256: ID_SHA, subjectFingerprint: fingerprintOf(label),
    method: "IN_PERSON_BRANCH", note: "Synthetic client attended a branch; face matched the ID photo.",
    approvedAt: APPROVED_AT_ISO, approvedById: "reviewer_ip_lapse", approvedByEmail: "reviewer@test.invalid", approvedWithTotp: true,
  })
  sql(`
    INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
    VALUES ('${clientId}', 'tenant_ip_lapse', 'CLI-${label}', 'IPLAPSE-${label}', 'Synthetic', 'Upgrade',
      '${label}@test.invalid', '+27820000077', CURRENT_TIMESTAMP);
    INSERT INTO "ClientDocument" ("id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "verified", "verifiedAt", "contentSha256")
    VALUES ${core};
    INSERT INTO "ComplianceRecord" ("id", "tenantId", "type", "referenceId", "status", "completedAt", "data", "updatedAt")
    VALUES ('exception_${label}', 'tenant_ip_lapse', 'KYC_EXCEPTION', '${clientId}', 'COMPLETED', '${APPROVED_AT}',
      '${record}'::jsonb, CURRENT_TIMESTAMP);
  `)
  if (laterAttempt) {
    sql(`INSERT INTO "ClientDocument" ("id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "verified",
        "contentSha256", "extractionStatus", "validationMismatch", "biometricResult", "createdAt")
      VALUES ('selfie_${label}', 'tenant_ip_lapse', '${clientId}', 'SELFIE', '', 'selfie.jpg', false, '${"e".repeat(64)}',
        '${laterAttempt.status}', true, '${JSON.stringify(laterAttempt.result)}'::jsonb, '${AFTER_ATTESTATION}');`)
  }
  sql(`UPDATE "Client" SET "kycStatus" = 'VERIFIED', "kycVerifiedAt" = CURRENT_TIMESTAMP,
    "kycVerifiedById" = 'reviewer_ip_lapse', "kycVerificationMethod" = 'PHYSICAL' WHERE "id" = '${clientId}';`)
  return clientId
}

const status = (clientId: string) => sql(`SELECT "kycStatus" FROM "Client" WHERE "id" = '${clientId}';`)
const touch = (clientId: string, phone: string) =>
  sql(`UPDATE "Client" SET "phone" = '${phone}', "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '${clientId}';`)
const migrationAudits = (clientId: string) => sql(`SELECT coalesce(json_agg(json_build_object(
    'userId', "userId", 'userEmail', "userEmail", 'action', "action", 'entity', "entity",
    'old', "oldValue" ->> 'kycStatus', 'new', "newValue" ->> 'kycStatus', 'reason', "newValue" ->> 'reason',
    'documentId', "newValue" ->> 'documentId', 'scope', "newValue" ->> 'evidenceScope')), '[]'::json)
  FROM "AuditLog" WHERE "entityId" = '${clientId}' AND "newValue" ->> 'documentId' = '${MIGRATION}';`)

suite("in-person lapse migration on a database holding clients main still produces", () => {
  const unknownOutcome = idOf("unknown")
  const clean = idOf("clean")
  const benign = idOf("benign")
  let writableBefore = ""
  let statusBefore = ""

  beforeAll(() => {
    psql(databaseUrl(), ["-c", `CREATE DATABASE "${name}"`])
    const earlier = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < MIGRATION)
      .map((entry) => entry.name)
      .sort()
    for (const dir of earlier) applyMigration(dir)
    sql(`INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt")
      VALUES ('tenant_ip_lapse', 'ip-lapse', 'In-person lapse upgrade', CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id", "tenantId", "email", "password", "role", "active", "totpEnabled", "lastTotpCounter", "updatedAt")
      VALUES ('reviewer_ip_lapse', 'tenant_ip_lapse', 'reviewer@test.invalid', 'synthetic', 'ADMIN', true, true, 1, CURRENT_TIMESTAMP);`)
    // Main's catch path wrote this after the attestation: VERIFIED before the migration.
    seedVerifiedInPerson("unknown", {
      status: "failed", result: { biometricFailureReason: "biometric_outcome_not_recorded" },
    })
    seedVerifiedInPerson("clean", null)
    seedVerifiedInPerson("benign", { status: "failed", result: { biometricFailureReason: "face_not_detected" } })
    writableBefore = touch(unknownOutcome, "+27820000001")
    statusBefore = status(unknownOutcome)
    applyMigration(MIGRATION)
  }, 120_000)

  afterAll(() => {
    psql(databaseUrl(), ["-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`])
  })

  it("seeded the client VERIFIED before the migration, so the demotion is the migration's doing", () => {
    expect(statusBefore).toBe("VERIFIED")
    expect(writableBefore).toBe("UPDATE 1")
  })

  it("demotes the client whose attestation the new predicate refuses", () => {
    expect(status(unknownOutcome)).toBe("PENDING")
  })

  it("audits the demotion once, as a system KYC_STATUS_CHANGED naming the migration", () => {
    expect(JSON.parse(migrationAudits(unknownOutcome))).toEqual([{
      userId: null,
      userEmail: "database@composite-kyc-guard",
      action: "KYC_STATUS_CHANGED",
      entity: "Client",
      old: "VERIFIED",
      new: "PENDING",
      reason: "composite_kyc_evidence_changed",
      documentId: MIGRATION,
      scope: "MIGRATION",
    }])
  })

  it("leaves clients the predicate still accepts VERIFIED and unaudited", () => {
    for (const id of [clean, benign]) {
      expect(status(id)).toBe("VERIFIED")
      expect(JSON.parse(migrationAudits(id))).toEqual([])
    }
  })

  it("keeps every client writable by an unrelated update", () => {
    for (const id of [unknownOutcome, clean, benign]) {
      expect(() => touch(id, "+27820000099")).not.toThrow()
      expect(sql(`SELECT "phone" FROM "Client" WHERE "id" = '${id}';`)).toBe("+27820000099")
    }
  })

  it("refuses to re-verify the demoted client on the lapsed attestation", () => {
    expect(() => sql(`UPDATE "Client" SET "kycStatus" = 'VERIFIED', "kycVerifiedAt" = CURRENT_TIMESTAMP,
      "kycVerifiedById" = 'reviewer_ip_lapse', "kycVerificationMethod" = 'PHYSICAL'
      WHERE "id" = '${unknownOutcome}';`)).toThrow(NOT_VERIFIED)
  })
})
