/**
 * Real-Postgres proof for the asset-finance foundation rules
 * (20261013090000_asset_finance_foundation):
 *   - Loan / LoanApplication carry exactly one of clientId / entityId;
 *   - only an entity borrower can be NON_NCA;
 *   - an entity's registration number is unique per tenant and type;
 *   - a NON_NCA entity application can go DRAFT → APPROVED → DISBURSED without
 *     the consumer PASQ / credit-life / countersign evidence, while an NCA
 *     entity application still cannot be DISBURSED without it.
 *
 *   RUN_ASSET_FINANCE_FOUNDATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/borrower-xor.integration.test.ts
 */
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_ASSET_FINANCE_FOUNDATION_IT === "1"
const databaseUrl = process.env.DATABASE_URL
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "").slice(0, 16)

function run(value: string): { ok: boolean; output: string } {
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the asset finance foundation integration test")
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

function expectRejected(statement: string, constraintOrMessage: string): void {
  const result = run(statement)
  expect(result.ok).toBe(false)
  expect(result.output).toContain(constraintOrMessage)
}

suite("asset finance foundation: borrower XOR, regime and entity rules", () => {
  const tenantId = `tenant_af_${token}`
  const clientId = `client_af_${token}`
  const entityId = `entity_af_${token}`
  const productId = `product_af_${token}`
  const userId = `user_af_${token}`
  let seq = 0

  function application(borrower: { clientId?: string; entityId?: string }, regime: "NCA" | "NON_NCA" | null): string {
    seq += 1
    const id = `app_af_${token}_${seq}`
    const statement = `
      INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "entityId", "productId",
        "appliedAmount", "appliedTermDays", "ncaRegime", "ncaClassificationRule", "ncaClassifiedAt",
        "ncaClassifiedById", "updatedAt")
      VALUES ('${id}', '${tenantId}', 'AF-${token}-${seq}', ${borrower.clientId ? `'${borrower.clientId}'` : "NULL"},
        ${borrower.entityId ? `'${borrower.entityId}'` : "NULL"}, '${productId}', 150000000, 1825,
        ${regime ? `'${regime}', 'TEST_RULE', CURRENT_TIMESTAMP, '${userId}'` : "NULL, NULL, NULL, NULL"},
        CURRENT_TIMESTAMP)`
    return statement
  }

  function loan(applicationId: string, borrower: { clientId?: string; entityId?: string }, regime: "NCA" | "NON_NCA"): string {
    seq += 1
    return `
      INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId", "clientId", "entityId", "productId",
        "principal", "totalInterest", "initiationFee", "totalRepayable", "outstandingPrincipal",
        "startDate", "maturityDate", "interestRatePm", "interestModel", "ncaRegime", "contractType", "updatedAt")
      VALUES ('loan_af_${token}_${seq}', '${tenantId}', 'AFL-${token}-${seq}', '${applicationId}',
        ${borrower.clientId ? `'${borrower.clientId}'` : "NULL"}, ${borrower.entityId ? `'${borrower.entityId}'` : "NULL"},
        '${productId}', 150000000, 1, 0, 150000001, 150000000, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP + INTERVAL '5 years', 1.0, 'DAILY_ACCRUAL', '${regime}',
        '${regime === "NON_NCA" ? "INSTALMENT_SALE" : "LOAN"}', CURRENT_TIMESTAMP)`
  }

  const idOf = (statement: string): string => {
    const match = /VALUES \('([^']+)'/.exec(statement)
    if (!match) throw new Error("no id in statement")
    return match[1]
  }

  beforeAll(() => {
    sql(`
      INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('${tenantId}', 'af-${token}', 'AF test', CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id", "tenantId", "email", "password", "updatedAt")
        VALUES ('${userId}', '${tenantId}', 'af-${token}@test.invalid', 'x', CURRENT_TIMESTAMP);
      INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
        VALUES ('${clientId}', '${tenantId}', 'CLI-${token}', 'ID-${token}', 'Test', 'Director', 'c-${token}@test.invalid', '+27820000000', CURRENT_TIMESTAMP);
      INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount",
        "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
        VALUES ('${productId}', '${tenantId}', 'AF-${token}', 'AF test product', 'PERSONAL', 100, 1000000000, 30, 3650, 1.0, 'DAILY_ACCRUAL');
      INSERT INTO "BusinessEntity" ("id", "tenantId", "type", "legalName", "registrationNumber", "updatedAt")
        VALUES ('${entityId}', '${tenantId}', 'COMPANY', 'TEST Plant Hire (Pty) Ltd', '2099/${token.slice(0, 6)}/07', CURRENT_TIMESTAMP);
    `)
  })

  afterAll(() => {
    sql(`
      DELETE FROM "RepaymentSchedule" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Loan" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "NcaRegimeOverride" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "LoanApplication" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "EntityRelationship" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "BusinessEntity" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "LoanProduct" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Client" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "User" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Tenant" WHERE "id" = '${tenantId}';
    `)
  })

  // One open application per client and product: each consumer case gets its own client.
  function freshClient(): string {
    seq += 1
    const id = `client_af_${token}_${seq}`
    sql(`INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
         VALUES ('${id}', '${tenantId}', 'CLI-${token}-${seq}', 'ID-${token}-${seq}', 'Test', 'Consumer',
         'c-${token}-${seq}@test.invalid', '+27820000000', CURRENT_TIMESTAMP)`)
    return id
  }

  it("rejects an application with neither a client nor an entity", () => {
    expectRejected(application({}, null), "LoanApplication_borrower_xor")
  })

  it("rejects an application with both a client and an entity", () => {
    expectRejected(application({ clientId, entityId }, null), "LoanApplication_borrower_xor")
  })

  it("rejects a NON_NCA application for a natural-person client", () => {
    expectRejected(application({ clientId }, "NON_NCA"), "LoanApplication_non_nca_requires_entity")
  })

  it("rejects a Loan with no borrower, two borrowers, or a NON_NCA client", () => {
    const app = application({ entityId }, "NON_NCA")
    sql(app)
    // The borrower trigger would refuse these first; switch it off inside a
    // rolled-back transaction so the CHECKs themselves are what is proven.
    const bare = (statement: string) => `BEGIN;
      ALTER TABLE "Loan" DISABLE TRIGGER "Loan_guard_borrower_regime_insert";
      ${statement};
      ROLLBACK;`
    expectRejected(bare(loan(idOf(app), {}, "NCA")), "Loan_borrower_xor")
    expectRejected(bare(loan(idOf(app), { clientId, entityId }, "NCA")), "Loan_borrower_xor")
    expectRejected(bare(loan(idOf(app), { clientId }, "NON_NCA")), "Loan_non_nca_requires_entity")
  })

  it("defaults a Loan to NCA / LOAN when the booking path does not say otherwise", () => {
    const consumer = freshClient()
    const app = application({ clientId: consumer }, null)
    sql(app)
    sql(`
      INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId", "clientId", "productId", "principal",
        "totalInterest", "initiationFee", "totalRepayable", "outstandingPrincipal", "startDate", "maturityDate",
        "interestRatePm", "interestModel", "updatedAt")
      VALUES ('loan_def_${token}', '${tenantId}', 'AFD-${token}', '${idOf(app)}', '${consumer}', '${productId}',
        100000, 1, 0, 100001, 100000, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1.0, 'DAILY_ACCRUAL', CURRENT_TIMESTAMP)`)
    expect(sql(`SELECT "ncaRegime" || '/' || "contractType" FROM "Loan" WHERE "id" = 'loan_def_${token}'`)).toBe("NCA/LOAN")
  })

  it("rejects a second entity with the same tenant, type and registration number", () => {
    expectRejected(
      `INSERT INTO "BusinessEntity" ("id", "tenantId", "type", "legalName", "registrationNumber", "updatedAt")
       SELECT 'dup_${token}', "tenantId", "type", 'Other name', "registrationNumber", CURRENT_TIMESTAMP
       FROM "BusinessEntity" WHERE "id" = '${entityId}'`,
      "BusinessEntity_tenantId_type_registrationNumber_key",
    )
  })

  it("allows the same registration number under a different entity type", () => {
    sql(`
      INSERT INTO "BusinessEntity" ("id", "tenantId", "type", "legalName", "registrationNumber", "updatedAt")
      SELECT 'trust_${token}', "tenantId", 'TRUST', 'TEST Family Trust', "registrationNumber", CURRENT_TIMESTAMP
      FROM "BusinessEntity" WHERE "id" = '${entityId}'`)
  })

  it("requires a trustee kind on a trustee relationship, and only there", () => {
    const rel = (id: string, role: string, kind: string | null) => `
      INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "trusteeKind", "updatedAt")
      VALUES ('${id}_${token}', '${tenantId}', '${entityId}', '${clientId}', '${role}', ${kind ? `'${kind}'` : "NULL"}, CURRENT_TIMESTAMP)`
    expectRejected(rel("r1", "TRUSTEE", null), "EntityRelationship_trustee_kind")
    expectRejected(rel("r2", "DIRECTOR", "NATURAL"), "EntityRelationship_trustee_kind")
    sql(rel("r3", "DIRECTOR", null))
    sql(rel("r4", "SURETY", null))
  })

  it("lets a NON_NCA entity deal reach DISBURSED without consumer PASQ evidence", () => {
    const app = application({ entityId }, "NON_NCA")
    sql(app)
    const id = idOf(app)
    sql(`UPDATE "LoanApplication" SET "status" = 'SUBMITTED' WHERE "id" = '${id}'`)
    sql(`UPDATE "LoanApplication" SET "status" = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = CURRENT_TIMESTAMP,
         "approvedById" = '${userId}' WHERE "id" = '${id}'`)
    // Booking and disbursement commit together (assertDisbursedCreditLifeCommitInvariant).
    sql(`${loan(id, { entityId }, "NON_NCA")}; UPDATE "LoanApplication" SET "status" = 'DISBURSED', "disbursedAt" = CURRENT_TIMESTAMP WHERE "id" = '${id}'`)
    expect(sql(`SELECT "status" FROM "LoanApplication" WHERE "id" = '${id}'`)).toBe("DISBURSED")
  })

  it("keeps the consumer approval rules for an entity deal classified NCA", () => {
    const app = application({ entityId }, "NCA")
    sql(app)
    expectRejected(
      `UPDATE "LoanApplication" SET "status" = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = CURRENT_TIMESTAMP,
         "approvedById" = '${userId}' WHERE "id" = '${idOf(app)}'`,
      "credit-life",
    )
  })

  it("keeps the consumer approval rules for a consumer application", () => {
    const app = application({ clientId: freshClient() }, null)
    sql(app)
    expectRejected(
      `UPDATE "LoanApplication" SET "status" = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = CURRENT_TIMESTAMP,
         "approvedById" = '${userId}' WHERE "id" = '${idOf(app)}'`,
      "credit-life",
    )
  })

  it("rejects a regime without its classification record", () => {
    expectRejected(
      `UPDATE "LoanApplication" SET "ncaClassifiedById" = NULL WHERE "tenantId" = '${tenantId}' AND "ncaRegime" IS NOT NULL`,
      "LoanApplication_nca_classification_complete",
    )
  })

  it("allows NCA → NON_NCA only through an approved override, before a decision", () => {
    const app = application({ entityId }, "NCA")
    sql(app)
    const id = idOf(app)
    const flip = `UPDATE "LoanApplication" SET "ncaRegime" = 'NON_NCA' WHERE "id" = '${id}'`
    expectRejected(flip, "requires an approved NcaRegimeOverride")
    sql(`INSERT INTO "NcaRegimeOverride" ("id", "tenantId", "applicationId", "fromRegime", "toRegime", "reason", "requestedById")
         VALUES ('ovr_${token}', '${tenantId}', '${id}', 'NCA', 'NON_NCA', 'AFS verified late', '${userId}')`)
    expectRejected(flip, "requires an approved NcaRegimeOverride")
    expectRejected(
      `UPDATE "NcaRegimeOverride" SET "status" = 'APPROVED', "decidedById" = '${userId}', "decidedAt" = CURRENT_TIMESTAMP WHERE "id" = 'ovr_${token}'`,
      "NcaRegimeOverride_four_eyes",
    )
    sql(`UPDATE "NcaRegimeOverride" SET "status" = 'APPROVED', "decidedById" = 'other_${token}', "decidedAt" = CURRENT_TIMESTAMP WHERE "id" = 'ovr_${token}'`)
    sql(flip)
    // Back to NCA directly: the earlier approval no longer authorises a flip,
    // and the change timestamp cannot be reset to revive it.
    sql(`UPDATE "LoanApplication" SET "ncaRegime" = 'NCA' WHERE "id" = '${id}'`)
    expectRejected(flip, "requires an approved NcaRegimeOverride")
    expectRejected(
      `UPDATE "LoanApplication" SET "ncaRegimeChangedAt" = NULL WHERE "id" = '${id}'`,
      "maintained by the database",
    )
    expectRejected(
      `INSERT INTO "NcaRegimeOverride" ("id", "tenantId", "applicationId", "fromRegime", "toRegime", "reason", "requestedById")
       VALUES ('ovr2_${token}', '${tenantId}', '${id}', 'NCA', 'NON_NCA', 'second request', '${userId}'),
              ('ovr3_${token}', '${tenantId}', '${id}', 'NCA', 'NON_NCA', 'third request', '${userId}')`,
      "NcaRegimeOverride_one_pending_per_application",
    )
  })

  it("freezes an application's regime once it is decided, and refuses a decided NON_NCA insert", () => {
    const app = application({ entityId }, "NON_NCA")
    sql(app)
    const id = idOf(app)
    sql(`UPDATE "LoanApplication" SET "status" = 'APPROVED', "repaymentMethod" = 'EFT', "approvedAt" = CURRENT_TIMESTAMP,
         "approvedById" = '${userId}' WHERE "id" = '${id}'`)
    expectRejected(`UPDATE "LoanApplication" SET "ncaRegime" = 'NCA' WHERE "id" = '${id}'`, "frozen once it is decided")
    expectRejected(
      application({ entityId }, "NON_NCA").replace(`"updatedAt")`, `"updatedAt", "status")`).replace(/CURRENT_TIMESTAMP\)$/, "CURRENT_TIMESTAMP, 'DECLINED')"),
      "must be classified before it is decided",
    )
  })

  it("binds a loan to its application's borrower and regime, and fixes them", () => {
    const consumerApp = application({ clientId: freshClient() }, null)
    sql(consumerApp)
    expectRejected(loan(idOf(consumerApp), { entityId }, "NCA"), "must carry its application's tenant, borrower and NCA regime")
    const entityApp = application({ entityId }, "NON_NCA")
    sql(entityApp)
    expectRejected(loan(idOf(entityApp), { entityId }, "NCA"), "must carry its application's tenant, borrower and NCA regime")
    const ok = loan(idOf(entityApp), { entityId }, "NON_NCA")
    sql(ok)
    expectRejected(`UPDATE "Loan" SET "ncaRegime" = 'NCA' WHERE "id" = '${idOf(ok)}'`, "fixed at booking")
  })

  it("validates the borrower CHECKs, so they cover rows that already existed", () => {
    expect(
      sql(`SELECT string_agg(conname || '=' || convalidated, ',' ORDER BY conname) FROM pg_constraint
           WHERE conname IN ('Loan_borrower_xor', 'LoanApplication_borrower_xor')`),
    ).toBe("LoanApplication_borrower_xor=true,Loan_borrower_xor=true")
  })
})
