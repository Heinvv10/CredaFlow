/**
 * Real-Postgres proof for the asset-finance foundation borrower and entity
 * rules (20261013090000_asset_finance_foundation):
 *   - Loan / LoanApplication carry exactly one of clientId / entityId;
 *   - only an entity borrower can be NON_NCA;
 *   - an entity's registration number is unique per tenant and type, and its
 *     relationships' trustee kind and ownership share are well-formed;
 *   - a NON_NCA entity application can go DRAFT → APPROVED → DISBURSED without
 *     the consumer PASQ / credit-life / countersign evidence, while an NCA
 *     entity application still cannot be DISBURSED without it.
 * The regime and override rules are regime-override.integration.test.ts; the
 * loan booking rules are loan-regime.integration.test.ts.
 *
 *   RUN_ASSET_FINANCE_FOUNDATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/borrower-xor.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { afSqlFixture, expectRejected, idOf, sql } from "./af-sql.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_FOUNDATION_IT === "1"
const suite = RUN ? describe : describe.skip

suite("asset finance foundation: borrower XOR and entity rules", () => {
  const f = afSqlFixture("afb")
  const { tenantId, clientId, entityId, productId, token } = f.ids

  beforeAll(() => f.seed())
  afterAll(() => f.cleanup())

  it("rejects an application with neither a client nor an entity", () => {
    expectRejected(f.application({}, null), "LoanApplication_borrower_xor")
  })

  it("rejects an application with both a client and an entity", () => {
    expectRejected(f.application({ clientId, entityId }, null), "LoanApplication_borrower_xor")
  })

  it("rejects a NON_NCA regime on a natural-person client's application; no NON_NCA override can be requested for one", () => {
    const app = f.application({ clientId: f.freshClient() }, "NCA")
    sql(app)
    // A NON_NCA request records the entity it is for; a consumer has none.
    expectRejected(f.pendingOverride(idOf(app)).statement, "NcaRegimeOverride_non_nca_snapshot")
    // The regime trigger refuses the flip first (no approval): switch it off
    // inside a rolled-back transaction so the CHECK itself is what is proven.
    expectRejected(`BEGIN;
      ALTER TABLE "LoanApplication" DISABLE TRIGGER "LoanApplication_guard_nca_regime_update";
      UPDATE "LoanApplication" SET "ncaRegime" = 'NON_NCA' WHERE "id" = '${idOf(app)}';
      ROLLBACK;`, "LoanApplication_non_nca_requires_entity")
  })

  it("rejects a Loan with no borrower, two borrowers, or a NON_NCA client", () => {
    const appId = f.nonNcaApplication()
    // The borrower trigger would refuse these first; switch it off inside a
    // rolled-back transaction so the CHECKs themselves are what is proven.
    const bare = (statement: string) => `BEGIN;
      ALTER TABLE "Loan" DISABLE TRIGGER "Loan_guard_borrower_regime_insert";
      ${statement};
      ROLLBACK;`
    expectRejected(bare(f.loan(appId, {}, "NCA")), "Loan_borrower_xor")
    expectRejected(bare(f.loan(appId, { clientId, entityId }, "NCA")), "Loan_borrower_xor")
    expectRejected(bare(f.loan(appId, { clientId }, "NON_NCA")), "Loan_non_nca_requires_entity")
  })

  it("defaults a Loan to NCA / LOAN when the booking path does not say otherwise", () => {
    const consumer = f.freshClient()
    const app = f.application({ clientId: consumer }, null)
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

  const relationship = (id: string, role: string, kind: string | null, ownershipPct: string | null = null) => `
    INSERT INTO "EntityRelationship" ("id", "tenantId", "entityId", "clientId", "role", "trusteeKind", "ownershipPct", "updatedAt")
    VALUES ('${id}_${token}', '${tenantId}', '${entityId}', '${clientId}', '${role}', ${kind ? `'${kind}'` : "NULL"},
      ${ownershipPct ?? "NULL"}, CURRENT_TIMESTAMP)`

  it("requires a trustee kind on a trustee relationship, and only there", () => {
    expectRejected(relationship("r1", "TRUSTEE", null), "EntityRelationship_trustee_kind")
    expectRejected(relationship("r2", "DIRECTOR", "NATURAL"), "EntityRelationship_trustee_kind")
    sql(relationship("r3", "DIRECTOR", null))
    sql(relationship("r4", "SURETY", null))
  })

  it("keeps an ownership share between 0 and 100 per cent", () => {
    expectRejected(relationship("r5", "BENEFICIAL_OWNER", null, "100.01"), "EntityRelationship_ownership_pct_range")
    expectRejected(relationship("r6", "BENEFICIAL_OWNER", null, "-0.01"), "EntityRelationship_ownership_pct_range")
    sql(relationship("r7", "BENEFICIAL_OWNER", null, "100"))
  })

  it("lets a NON_NCA entity deal reach DISBURSED without consumer PASQ evidence", () => {
    const id = f.nonNcaApplication()
    sql(`UPDATE "LoanApplication" SET "status" = 'SUBMITTED' WHERE "id" = '${id}'`)
    sql(f.approveApplication(id))
    // Booking and disbursement commit together (assertDisbursedCreditLifeCommitInvariant).
    sql(`${f.loan(id, { entityId }, "NON_NCA")}; ${f.disburse(id)}`)
    expect(sql(`SELECT "status" FROM "LoanApplication" WHERE "id" = '${id}'`)).toBe("DISBURSED")
  })

  it("keeps the consumer approval rules for an entity deal classified NCA", () => {
    const app = f.application({ entityId }, "NCA")
    sql(app)
    expectRejected(f.approveApplication(idOf(app)), "credit-life")
  })

  it("keeps the consumer approval rules for a consumer application", () => {
    const app = f.application({ clientId: f.freshClient() }, null)
    sql(app)
    expectRejected(f.approveApplication(idOf(app)), "credit-life")
  })

  it("rejects a regime without its classification record", () => {
    const app = f.application({ entityId }, "NCA")
    sql(app)
    expectRejected(
      `UPDATE "LoanApplication" SET "ncaClassifiedById" = NULL WHERE "id" = '${idOf(app)}'`,
      "LoanApplication_nca_classification_complete",
    )
  })

  it("keeps a product's NON_NCA arrears terms non-negative", () => {
    expectRejected(
      `UPDATE "LoanProduct" SET "nonNcaDefaultInterestMargin" = -0.01 WHERE "id" = '${productId}'`,
      "LoanProduct_non_nca_arrears_terms",
    )
    expectRejected(
      `UPDATE "LoanProduct" SET "nonNcaCollectionFeeCents" = -1 WHERE "id" = '${productId}'`,
      "LoanProduct_non_nca_arrears_terms",
    )
    sql(`UPDATE "LoanProduct" SET "nonNcaDefaultInterestMargin" = 0, "nonNcaCollectionFeeCents" = 0 WHERE "id" = '${productId}'`)
  })

  it("validates the borrower CHECKs, so they cover rows that already existed", () => {
    expect(
      sql(`SELECT string_agg(conname || '=' || convalidated, ',' ORDER BY conname) FROM pg_constraint
           WHERE conname IN ('Loan_borrower_xor', 'LoanApplication_borrower_xor')`),
    ).toBe("LoanApplication_borrower_xor=true,Loan_borrower_xor=true")
  })
})
