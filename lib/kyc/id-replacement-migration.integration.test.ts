/**
 * Upgrade proof for migration 20261014130000_replacement_id_pending_not_verified:
 * a client VERIFIED before the migration while a newer, unreviewed ID copy
 * sat on file (the old rule honoured the older verified copy) is demoted by
 * it with one audit row, instead of being left unwritable by
 * Client_enforce_composite_kyc. Clients the rule does not touch are left alone.
 *
 * Self-contained: creates its own throwaway database next to DATABASE_URL's,
 * applies the migrations BEFORE this one, seeds, applies this one, and drops
 * the database. The role in DATABASE_URL therefore needs CREATEDB.
 *
 *   RUN_REPLACEMENT_ID_MIGRATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/kyc/id-replacement-migration.integration.test.ts
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

const RUN = process.env.RUN_REPLACEMENT_ID_MIGRATION_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const MIGRATION = "20261014130000_replacement_id_pending_not_verified"
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations")
const NOT_VERIFIED = "Client KYC cannot be VERIFIED without current composite evidence"
const TENANT = "tenant_repl_id_mig"
const name = `repl_id_mig_${randomBytes(6).toString("hex")}`
const ID_SHA = "a".repeat(64)
const [APPROVED_AT, APPROVED_AT_ISO] = ["2026-10-10 12:00:00.000", "2026-10-10T12:00:00.000Z"]

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

const subjectOf = (label: string) => ({
  id: `client_${label}`, idNumber: `REPLMIG-${label}`, firstName: "Synthetic", lastName: "Upgrade", dateOfBirth: null,
})

/**
 * A client VERIFIED in person on four verified core documents. `replacement`
 * adds a newer ID copy: "unreviewed", "refused", or none.
 */
function seedVerifiedClient(label: string, replacement: "unreviewed" | "refused" | null, status = "VERIFIED") {
  const { id: clientId, idNumber } = subjectOf(label)
  const core = ["ID_COPY", "PROOF_OF_ADDRESS", "PAYSLIP", "BANK_STATEMENT"]
    .map((docType) => `('core_${label}_${docType}', '${TENANT}', '${clientId}', '${docType}', '', 'core.pdf', true, CURRENT_TIMESTAMP, '${ID_SHA}')`)
    .join(",\n")
  const record = JSON.stringify({
    kind: IN_PERSON_KYC_VERIFICATION_KIND, version: IN_PERSON_KYC_VERIFICATION_VERSION,
    clientId, subjectFingerprint: biometricSubjectFingerprint(subjectOf(label)),
    idDocumentId: `core_${label}_ID_COPY`, idDocumentSha256: ID_SHA, method: "IN_PERSON_BRANCH",
    note: "Synthetic client attended a branch; face matched the ID photo.",
    approvedAt: APPROVED_AT_ISO, approvedById: "reviewer-synthetic", approvedByEmail: "reviewer@test.invalid",
    approvedWithTotp: true,
  })
  sql(`
    INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
    VALUES ('${clientId}', '${TENANT}', 'CLI-${label}', '${idNumber}', 'Synthetic', 'Upgrade',
      '${label}@test.invalid', '+27820000077', CURRENT_TIMESTAMP);
    INSERT INTO "ClientDocument" ("id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "verified", "verifiedAt", "contentSha256")
    VALUES ${core};
    INSERT INTO "ComplianceRecord" ("id", "tenantId", "type", "referenceId", "status", "completedAt", "data", "updatedAt")
    VALUES ('attestation_${label}', '${TENANT}', 'KYC_EXCEPTION', '${clientId}', 'COMPLETED', '${APPROVED_AT}',
      '${record}'::jsonb, CURRENT_TIMESTAMP);
  `)
  if (replacement) {
    const refusal = replacement === "refused"
      ? `, "verificationRejectedAt", "verificationRejectedById"`
      : ""
    const refusalValues = replacement === "refused" ? `, CURRENT_TIMESTAMP, 'reviewer-synthetic'` : ""
    sql(`INSERT INTO "ClientDocument" ("id", "tenantId", "clientId", "docType", "fileUrl", "fileName", "verified",
        "contentSha256", "createdAt"${refusal})
      VALUES ('replacement_${label}', '${TENANT}', '${clientId}', 'ID_COPY', '', 'id-new.pdf', false,
        '${"b".repeat(64)}', CURRENT_TIMESTAMP + interval '1 day'${refusalValues});`)
  }
  if (status === "VERIFIED") {
    sql(`UPDATE "Client" SET "kycStatus" = 'VERIFIED', "kycVerifiedAt" = CURRENT_TIMESTAMP,
      "kycVerifiedById" = 'reviewer-synthetic', "kycVerificationMethod" = 'PHYSICAL' WHERE "id" = '${clientId}';`)
  }
  return clientId
}

const statusOf = (clientId: string) => sql(`SELECT "kycStatus" FROM "Client" WHERE "id" = '${clientId}';`)
const resetAudits = (clientId: string) => Number(sql(`SELECT count(*) FROM "AuditLog"
  WHERE "entityId" = '${clientId}' AND "id" = 'kyc-replacement-id-reset-${clientId}';`))

suite("replacement-ID migration on a database verified under the old rule", () => {
  let pendingId = ""
  let refusedId = ""
  let plainId = ""
  let notVerifiedId = ""
  let clashAbortedMigration = false
  let afterClash: Record<string, string> = {}
  let auditCountAfterFirstRun = 0

  beforeAll(() => {
    psql(databaseUrl(), ["-c", `CREATE DATABASE "${name}"`])
    const earlier = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name < MIGRATION)
      .map((entry) => entry.name)
      .sort()
    for (const dir of earlier) applyMigration(dir)
    sql(`INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt")
      VALUES ('${TENANT}', 'repl-id-mig', 'Replacement ID upgrade', CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id", "tenantId", "email", "password", "role", "active", "totpEnabled", "lastTotpCounter", "updatedAt")
      VALUES ('reviewer-synthetic', '${TENANT}', 'reviewer@test.invalid', 'synthetic', 'ADMIN', true, true, 1, CURRENT_TIMESTAMP);`)
    // Under the old rule all of these are accepted as VERIFIED.
    pendingId = seedVerifiedClient("pending", "unreviewed")
    refusedId = seedVerifiedClient("refused", "refused")
    plainId = seedVerifiedClient("plain", null)
    // Not VERIFIED: the data step must leave it alone and write no audit row.
    notVerifiedId = seedVerifiedClient("notverified", "unreviewed", "PENDING")

    // A pre-existing row with the demotion audit id must abort the whole
    // migration, not demote that client silently. Rolled back as one unit.
    try {
      psql(databaseUrl(name), [
        "--single-transaction",
        "-c", `INSERT INTO "AuditLog" ("id", "action", "entity") VALUES ('kyc-replacement-id-reset-${pendingId}', 'CLASH', 'Client');`,
        "-f", path.join(MIGRATIONS_DIR, MIGRATION, "migration.sql"),
      ])
    } catch (error) {
      clashAbortedMigration = String((error as { stderr?: unknown }).stderr).includes("duplicate key")
    }
    afterClash = {
      pending: statusOf(pendingId),
      helperExists: sql(`SELECT count(*) FROM pg_proc WHERE proname = 'subject_has_pending_id_replacement';`),
    }
    // The clash row was rolled back with the failed transaction (it ran in it).
    applyMigration(MIGRATION)
    auditCountAfterFirstRun = Number(sql(`SELECT count(*) FROM "AuditLog" WHERE "id" LIKE 'kyc-replacement-id-reset-%';`))
  }, 180_000)

  afterAll(() => {
    psql(databaseUrl(), ["-c", `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`])
  })

  it("aborts as one unit, demoting nobody and creating nothing, when a demotion audit id already exists", () => {
    expect(clashAbortedMigration).toBe(true)
    expect(afterClash).toEqual({ pending: "VERIFIED", helperExists: "0" })
  })

  it("demotes the client VERIFIED with an unreviewed newer ID copy, clearing provenance", () => {
    expect(sql(`SELECT concat_ws('|', "kycStatus", "kycVerifiedAt", "kycVerifiedById", "kycVerificationMethod")
      FROM "Client" WHERE "id" = '${pendingId}';`)).toBe("PENDING")
  })

  it("writes exactly one system audit row for the demotion", () => {
    expect(resetAudits(pendingId)).toBe(1)
    expect(JSON.parse(sql(`SELECT json_build_object('userId', "userId", 'userEmail', "userEmail", 'action', "action",
        'entity', "entity", 'old', "oldValue" ->> 'kycStatus', 'oldMethod', "oldValue" ->> 'kycVerificationMethod',
        'new', "newValue" ->> 'kycStatus', 'reason', "newValue" ->> 'reason', 'migration', "newValue" ->> 'migration')
      FROM "AuditLog" WHERE "id" = 'kyc-replacement-id-reset-${pendingId}';`))).toEqual({
      userId: null,
      userEmail: "migration@replacement-id-pending",
      action: "KYC_STATUS_CHANGED",
      entity: "Client",
      old: "VERIFIED",
      oldMethod: "PHYSICAL",
      new: "PENDING",
      reason: "replacement_id_pending_review",
      migration: MIGRATION,
    })
  })

  it("leaves a client whose newer copy was refused, one with no newer copy, and a PENDING one alone", () => {
    expect([statusOf(refusedId), statusOf(plainId), statusOf(notVerifiedId)]).toEqual(["VERIFIED", "VERIFIED", "PENDING"])
    expect([refusedId, plainId, notVerifiedId].map(resetAudits)).toEqual([0, 0, 0])
  })

  it("writes one audit row in total: nobody else was demoted", () => {
    expect(auditCountAfterFirstRun).toBe(1)
  })

  it("refuses to re-verify the demoted client while the replacement awaits review", () => {
    expect(() => sql(`UPDATE "Client" SET "kycStatus" = 'VERIFIED', "kycVerifiedAt" = CURRENT_TIMESTAMP,
      "kycVerificationMethod" = 'PHYSICAL', "kycVerifiedById" = 'reviewer-synthetic' WHERE "id" = '${pendingId}';`))
      .toThrow(NOT_VERIFIED)
  })

  it("is idempotent: applying the migration again changes and audits nothing", () => {
    applyMigration(MIGRATION)
    expect(statusOf(pendingId)).toBe("PENDING")
    expect(sql(`SELECT count(*) FROM "AuditLog" WHERE "id" LIKE 'kyc-replacement-id-reset-%';`)).toBe("1")
    expect([statusOf(refusedId), statusOf(plainId)]).toEqual(["VERIFIED", "VERIFIED"])
  })
})
