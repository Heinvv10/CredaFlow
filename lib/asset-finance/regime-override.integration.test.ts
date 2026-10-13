/**
 * Real-Postgres proof of the NCA regime and override rules
 * (20261013090000_asset_finance_foundation, DESIGN D5):
 *   - no application is inserted NON_NCA; every change to NON_NCA spends one
 *     approved, unapplied override (trigger guardLoanApplicationNcaRegime), so
 *     an approval cannot be replayed; a change to NCA is free; frozen once
 *     decided;
 *   - once classified the borrower is fixed; while NON_NCA the amount and
 *     product are fixed; while NON_NCA and once decided the classification
 *     snapshot is fixed;
 *   - an override is never deleted, starts PENDING when it relaxes the regime,
 *     is decided once by someone other than its requester, and is immutable
 *     after that except for being spent (guardNcaRegimeOverrideLifecycle and
 *     the NcaRegimeOverride CHECKs).
 *
 *   RUN_ASSET_FINANCE_FOUNDATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/regime-override.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { afSqlFixture, expectRejected, idOf, sql } from "./af-sql.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_FOUNDATION_IT === "1"
const suite = RUN ? describe : describe.skip

suite("asset finance foundation: NCA regime and override rules", () => {
  const f = afSqlFixture("afr")
  const { tenantId, entityId, otherEntityId, productId, userId, approverId, token } = f.ids
  const flip = (id: string) => `UPDATE "LoanApplication" SET "ncaRegime" = 'NON_NCA' WHERE "id" = '${id}'`
  const ncaApplication = () => {
    const app = f.application({ entityId }, "NCA")
    sql(app)
    return idOf(app)
  }
  const appliedAt = (overrideId: string) =>
    sql(`SELECT COALESCE("appliedAt"::TEXT, 'null') FROM "NcaRegimeOverride" WHERE "id" = '${overrideId}'`)

  beforeAll(() => f.seed())
  afterAll(() => f.cleanup())

  it("refuses to insert an application NON_NCA, whatever its status", () => {
    const insert = f.application({ entityId }, "NCA").replace(/'NCA', 'FINANCIALS_UNPROVEN'/, "'NON_NCA', 'FINANCIALS_UNPROVEN'")
    expectRejected(insert, "cannot be inserted NON_NCA")
  })

  it("refuses a change to NON_NCA with no override, a PENDING one, or from unclassified", () => {
    const id = ncaApplication()
    expectRejected(flip(id), "requires an approved NcaRegimeOverride that has not been applied")
    const override = f.pendingOverride(id)
    sql(override.statement)
    expectRejected(flip(id), "requires an approved NcaRegimeOverride that has not been applied")

    // Unclassified straight to NON_NCA: the snapshot cannot be written NON_NCA,
    // and no override can be requested for an unclassified application.
    const unclassified = f.application({ entityId }, null)
    sql(unclassified)
    expectRejected(
      `UPDATE "LoanApplication" SET "ncaRegime" = 'NON_NCA', "ncaClassificationRule" = 'FINANCIALS_UNPROVEN',
         "ncaClassifiedAt" = CURRENT_TIMESTAMP, "ncaClassifiedById" = '${userId}' WHERE "id" = '${idOf(unclassified)}'`,
      "classification snapshot is frozen while it is NON_NCA",
    )
  })

  it("spends an approval on exactly one change: back on NCA, the same approval cannot flip it again", () => {
    const id = ncaApplication()
    const override = f.pendingOverride(id)
    sql(`${override.statement}; ${f.approve(override.id)}`)
    expect(appliedAt(override.id)).toBe("null")
    sql(flip(id))
    expect(appliedAt(override.id)).not.toBe("null")
    // To NCA is free; the spent approval does not authorise the way back.
    sql(`UPDATE "LoanApplication" SET "ncaRegime" = 'NCA' WHERE "id" = '${id}'`)
    expectRejected(flip(id), "requires an approved NcaRegimeOverride that has not been applied")
    // A fresh request, approved by a second person, does.
    sql(f.toNonNca(id))
    expect(sql(`SELECT "ncaRegime" FROM "LoanApplication" WHERE "id" = '${id}'`)).toBe("NON_NCA")
  })

  it("never lets the requester approve a move to NCA → NON_NCA", () => {
    const id = ncaApplication()
    const override = f.pendingOverride(id)
    sql(override.statement)
    expectRejected(
      `UPDATE "NcaRegimeOverride" SET "status" = 'APPROVED', "decidedById" = '${userId}', "decidedAt" = CURRENT_TIMESTAMP
       WHERE "id" = '${override.id}'`,
      "NcaRegimeOverride_four_eyes",
    )
    sql(f.approve(override.id))
  })

  it("allows one PENDING override per application", () => {
    const id = ncaApplication()
    expectRejected(
      `${f.pendingOverride(id).statement}; ${f.pendingOverride(id).statement}`,
      "NcaRegimeOverride_one_pending_per_application",
    )
  })

  it("freezes an application's regime once it is decided", () => {
    const id = f.nonNcaApplication()
    sql(f.approveApplication(id))
    expectRejected(`UPDATE "LoanApplication" SET "ncaRegime" = 'NCA' WHERE "id" = '${id}'`, "frozen once it is decided")
  })

  it("fixes the borrower once classified, but not before", () => {
    const unclassified = f.application({ entityId }, null)
    sql(unclassified)
    sql(`UPDATE "LoanApplication" SET "entityId" = '${otherEntityId}' WHERE "id" = '${idOf(unclassified)}'`)
    const id = ncaApplication()
    expectRejected(
      `UPDATE "LoanApplication" SET "entityId" = '${otherEntityId}' WHERE "id" = '${id}'`,
      "classified application's borrower cannot change",
    )
  })

  it("fixes the amount and product while NON_NCA, but not while NCA", () => {
    const id = ncaApplication()
    sql(`UPDATE "LoanApplication" SET "appliedAmount" = 140000000 WHERE "id" = '${id}'`)
    sql(f.toNonNca(id))
    expectRejected(
      `UPDATE "LoanApplication" SET "appliedAmount" = 130000000 WHERE "id" = '${id}'`,
      "NON_NCA application's amount and product cannot change",
    )
    expectRejected(
      `UPDATE "LoanApplication" SET "productId" = '${productId}_x' WHERE "id" = '${id}'`,
      "NON_NCA application's amount and product cannot change",
    )
  })

  const snapshotWrites = [
    `"ncaClassificationRule" = 'JURISTIC_OVER_THRESHOLD'`,
    `"ncaClassificationInputs" = '{"principalDebtCents": 1}'::jsonb`,
    `"ncaClassificationEvidenceIds" = ARRAY['afs-x']`,
    `"ncaClassifiedAt" = CURRENT_TIMESTAMP + INTERVAL '1 day'`,
    `"ncaClassifiedById" = '${approverId}'`,
  ]

  it("fixes the classification snapshot while NON_NCA, even while open; back on NCA it may change", () => {
    const id = f.nonNcaApplication()
    for (const set of snapshotWrites) {
      expectRejected(`UPDATE "LoanApplication" SET ${set} WHERE "id" = '${id}'`, "snapshot is frozen while it is NON_NCA")
    }
    // Not in the same statement that leaves NON_NCA either: NCA first, then re-classify.
    expectRejected(
      `UPDATE "LoanApplication" SET "ncaRegime" = 'NCA', "ncaClassificationRule" = 'LARGE_AGREEMENT' WHERE "id" = '${id}'`,
      "snapshot is frozen while it is NON_NCA",
    )
    sql(`UPDATE "LoanApplication" SET "ncaRegime" = 'NCA' WHERE "id" = '${id}'`)
    sql(`UPDATE "LoanApplication" SET "ncaClassificationRule" = 'LARGE_AGREEMENT' WHERE "id" = '${id}'`)
  })

  it("fixes the classification snapshot once decided, NCA included", () => {
    const id = ncaApplication()
    sql(`UPDATE "LoanApplication" SET "ncaClassificationRule" = 'LARGE_AGREEMENT' WHERE "id" = '${id}'`)
    sql(`UPDATE "LoanApplication" SET "status" = 'DECLINED' WHERE "id" = '${id}'`)
    for (const set of snapshotWrites) {
      expectRejected(`UPDATE "LoanApplication" SET ${set} WHERE "id" = '${id}'`, "snapshot is frozen while it is NON_NCA and once it is decided")
    }
  })

  it("refuses an override that does not change the regime, or a half-recorded decision", () => {
    const id = ncaApplication()
    expectRejected(
      `INSERT INTO "NcaRegimeOverride" ("id", "tenantId", "applicationId", "fromRegime", "toRegime", "reason", "source", "requestedById")
       VALUES ('same_${token}', '${tenantId}', '${id}', 'NCA', 'NCA', 'no change', 'MANUAL', '${userId}')`,
      "NcaRegimeOverride_changes_regime",
    )
    const override = f.pendingOverride(id)
    sql(override.statement)
    expectRejected(
      `UPDATE "NcaRegimeOverride" SET "status" = 'REJECTED' WHERE "id" = '${override.id}'`,
      "NcaRegimeOverride_decision_complete",
    )
    expectRejected(
      `UPDATE "NcaRegimeOverride" SET "appliedAt" = CURRENT_TIMESTAMP WHERE "id" = '${override.id}'`,
      "NcaRegimeOverride_applied_requires_approval",
    )
  })

  it("refuses an override outside its application's tenant", () => {
    const id = ncaApplication()
    expectRejected(
      `INSERT INTO "NcaRegimeOverride" ("id", "tenantId", "applicationId", "fromRegime", "toRegime", "reason", "source", "requestedById")
       VALUES ('xt_${token}', 'some_other_tenant', '${id}', 'NCA', 'NON_NCA', 'cross tenant', 'MANUAL', '${userId}')`,
      "must belong to its application's tenant",
    )
  })

  it("starts every override to NON_NCA PENDING", () => {
    const id = ncaApplication()
    expectRejected(
      `INSERT INTO "NcaRegimeOverride" ("id", "tenantId", "applicationId", "fromRegime", "toRegime", "reason", "source",
         "requestedById", "status", "decidedById", "decidedAt")
       VALUES ('pre_${token}', '${tenantId}', '${id}', 'NCA', 'NON_NCA', 'pre-approved', 'MANUAL', '${userId}', 'APPROVED',
         '${approverId}', CURRENT_TIMESTAMP)`,
      "requested PENDING; a second person decides it",
    )
  })

  it("never deletes an override, never rewrites its request, and freezes it once decided except for spending it", () => {
    const id = ncaApplication()
    const override = f.pendingOverride(id)
    sql(override.statement)
    const where = `WHERE "id" = '${override.id}'`
    expectRejected(`UPDATE "NcaRegimeOverride" SET "reason" = 'rewritten request' ${where}`, "override request is immutable")
    expectRejected(`UPDATE "NcaRegimeOverride" SET "requestedById" = '${approverId}' ${where}`, "override request is immutable")
    expectRejected(`DELETE FROM "NcaRegimeOverride" ${where}`, "never deleted")

    sql(f.approve(override.id))
    expectRejected(
      `UPDATE "NcaRegimeOverride" SET "status" = 'REJECTED', "decisionNote" = 'changed my mind' ${where}`,
      "immutable once decided",
    )
    expectRejected(`UPDATE "NcaRegimeOverride" SET "decisionNote" = 'edited' ${where}`, "immutable once decided")
    expectRejected(`DELETE FROM "NcaRegimeOverride" ${where}`, "never deleted")

    sql(flip(id))
    expectRejected(`UPDATE "NcaRegimeOverride" SET "appliedAt" = NULL ${where}`, "immutable once decided")
    expectRejected(
      `UPDATE "NcaRegimeOverride" SET "appliedAt" = "appliedAt" + INTERVAL '1 second' ${where}`,
      "immutable once decided",
    )
  })
})
