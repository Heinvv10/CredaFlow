/**
 * Real-Postgres proof for 20261013130000_asset_finance_nca_borrower.
 * RUN_ASSET_FINANCE_NCA_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/asset-finance/nca-guards.integration.test.ts
 */
import { afterAll, beforeAll, describe, it } from "vitest"
import { afSqlFixture, expectRejected, idOf, sql } from "./af-sql.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_NCA_IT === "1"
const suite = RUN ? describe : describe.skip

suite("asset-finance NCA database guards", () => {
  const f = afSqlFixture("afnca")
  const { tenantId, clientId, userId, approverId, token } = f.ids
  const supplierId = `supplier_afnca_${token}`
  const assetId = `asset_afnca_${token}`
  let applicationId = ""
  let dealId = ""

  beforeAll(() => {
    f.seed()
    sql(`
      INSERT INTO "Supplier" ("id", "tenantId", "name", "updatedAt") VALUES ('${supplierId}', '${tenantId}', 'TEST Supplier', CURRENT_TIMESTAMP);
      INSERT INTO "FinancedAsset" ("id", "tenantId", "assetClass", "make", "model", "year", "serialNumber", "cashPriceExclVatCents", "vatCents", "updatedAt")
        VALUES ('${assetId}', '${tenantId}', 'EXCAVATOR', 'TEST', 'TLB', 2026, 'TEST-${token}', 1000000, 150000, CURRENT_TIMESTAMP);
      INSERT INTO "ReferenceRate" ("id", "tenantId", "basis", "effectiveDate", "rate", "requestedById")
        VALUES ('repo_${token}', '${tenantId}', 'REPO', '2020-01-01', 0.0725, '${userId}');
      UPDATE "ReferenceRate" SET "status" = 'APPROVED', "decidedById" = '${approverId}', "decidedAt" = CURRENT_TIMESTAMP
        WHERE "id" = 'repo_${token}';
    `)
    const app = f.application({ clientId }, "NCA", "NATURAL_PERSON_NCA", 1_000_000)
    sql(app)
    applicationId = idOf(app)
    dealId = `deal_afnca_${token}`
    sql(`INSERT INTO "AssetFinanceDeal" ("id", "tenantId", "applicationId", "clientId", "assetId", "supplierId", "depositCents", "tradeInCents", "financedFeesCents", "balloonCents", "weights", "structurePreset", "firstDueDate", "rateBasis", "fixedRate", "baseInstalmentCents", "createdById", "updatedAt")
      VALUES ('${dealId}', '${tenantId}', '${applicationId}', '${clientId}', '${assetId}', '${supplierId}', 0, 0, 0, 0, '[1,1]'::jsonb, 'MONTHLY', '2027-01-31', 'FIXED', 0.12, 50000, '${userId}', CURRENT_TIMESTAMP)`)
  })
  afterAll(() => f.cleanup())

  it("enforces client/entity XOR on the deal", () => {
    expectRejected(`UPDATE "AssetFinanceDeal" SET "clientId" = NULL WHERE "id" = '${dealId}'`, "AssetFinanceDeal_borrower_xor")
    expectRejected(`UPDATE "AssetFinanceDeal" SET "entityId" = '${f.ids.entityId}' WHERE "id" = '${dealId}'`, "AssetFinanceDeal_borrower_xor")
  })

  it("blocks NCA approval without an affordable s81 assessment", () => {
    sql(`UPDATE "LoanApplication" SET "status" = 'SUBMITTED' WHERE "id" = '${applicationId}'`)
    expectRejected(`UPDATE "LoanApplication" SET "status" = 'APPROVED', "repaymentMethod" = 'EFT', "approvedById" = '${userId}', "approvedAt" = CURRENT_TIMESTAMP WHERE "id" = '${applicationId}'`, "NCA asset approval requires an affordable s81 assessment")
  })

  it("blocks an NCA asset Loan above REPO plus 17 points", () => {
    const insert = f.loan(applicationId, { clientId }, "NCA", 1_000_000, "'2027-01-01'::timestamp")
      .replace("'LOAN'", "'INSTALMENT_SALE'")
    expectRejected(insert, "NCA asset annual interest exceeds REPO plus 17 percentage points")
  })
})
