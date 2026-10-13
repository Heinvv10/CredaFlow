/**
 * Real-Postgres proof of the rate-table rules: ReferenceRate four-eyes, band,
 * immutability and live-value uniqueness (migration 20261013100000);
 * ContractRate insert-only with its insert rules (20261013100500); and the
 * tenant-bound composite foreign keys of ContractRate, TaxInvoice and
 * CreditNote (20261013100700), each isolated from the trigger that would
 * otherwise refuse the row first.
 *
 *   RUN_ASSET_FINANCE_RATES_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/rates-db.integration.test.ts
 */
import { afterAll, beforeAll, describe, it } from "vitest"
import { afSqlFixture, expectRejected, idOf, sql } from "./af-sql.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_RATES_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("asset finance rate tables and tenant keys (real DB)", () => {
  const f = afSqlFixture("afr")
  const { tenantId, entityId, userId, approverId, token } = f.ids
  const otherTenant = `tenant_afr2_${token}`
  let seq = 0
  const loans = { nonNca: "", plain: "", nca: "" }

  const reference = (over: { date?: string; rate?: string; status?: string; decided?: string | null; basis?: string } = {}) => {
    seq += 1
    const decided = over.decided === undefined ? (over.status && over.status !== "PENDING" ? approverId : null) : over.decided
    const id = `rr_${token}_${seq}`
    return `INSERT INTO "ReferenceRate" ("id", "tenantId", "basis", "effectiveDate", "rate", "status", "requestedById", "decidedById", "decidedAt")
      VALUES ('${id}', '${tenantId}', '${over.basis ?? "PRIME"}', '${over.date ?? "2026-01-15"}', ${over.rate ?? "0.1175"},
      '${over.status ?? "PENDING"}', '${userId}', ${decided ? `'${decided}'` : "NULL"}, ${decided ? "CURRENT_TIMESTAMP" : "NULL"})`
  }
  const contractRate = (loanId: string, over: { date?: string; basis?: string; tenant?: string } = {}) => {
    seq += 1
    const fixed = over.basis === "FIXED"
    return `INSERT INTO "ContractRate" ("id", "tenantId", "loanId", "effectiveDate", "basis", "margin", "fixedRate", "resultingRate")
      VALUES ('cr_${token}_${seq}', '${over.tenant ?? tenantId}', '${loanId}', '${over.date ?? "2026-01-15"}', '${over.basis ?? "PRIME"}',
      ${fixed ? "NULL, 0.13" : "0.01, NULL"}, 0.1275)`
  }
  const approve = (id: string) =>
    `UPDATE "ReferenceRate" SET "status" = 'APPROVED', "decidedById" = '${approverId}', "decidedAt" = CURRENT_TIMESTAMP WHERE "id" = '${id}'`

  beforeAll(() => {
    f.seed()
    sql(`INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('${otherTenant}', 'afr2-${token}', 'AF other', CURRENT_TIMESTAMP)`)
    const book = (contractType: string) => {
      const app = f.nonNcaApplication()
      sql(f.approveApplication(app))
      const loan = f.loan(app, { entityId }, "NON_NCA").replace("'INSTALMENT_SALE', CURRENT_TIMESTAMP)", `'${contractType}', CURRENT_TIMESTAMP)`)
      sql(`${loan}; ${f.disburse(app)}`)
      return idOf(loan)
    }
    loans.nonNca = book("INSTALMENT_SALE")
    loans.plain = book("LOAN")
    const ncaApp = f.application({ entityId }, "NCA")
    sql(ncaApp)
    const nca = f.loan(idOf(ncaApp), { entityId }, "NCA").replace("'LOAN', CURRENT_TIMESTAMP)", "'INSTALMENT_SALE', CURRENT_TIMESTAMP)")
    sql(nca)
    loans.nca = idOf(nca)
  })

  afterAll(() => {
    sql(`BEGIN; SET LOCAL session_replication_role = replica;
      DELETE FROM "CreditNote" WHERE "tenantId" IN ('${tenantId}', '${otherTenant}');
      DELETE FROM "TaxInvoiceLine" WHERE "invoiceId" IN (SELECT "id" FROM "TaxInvoice" WHERE "tenantId" IN ('${tenantId}', '${otherTenant}'));
      DELETE FROM "TaxInvoice" WHERE "tenantId" IN ('${tenantId}', '${otherTenant}');
      DELETE FROM "TaxDocumentCounter" WHERE "tenantId" IN ('${tenantId}', '${otherTenant}');
      DELETE FROM "ContractRate" WHERE "tenantId" IN ('${tenantId}', '${otherTenant}');
      DELETE FROM "ReferenceRate" WHERE "tenantId" = '${tenantId}';
      DELETE FROM "Tenant" WHERE "id" = '${otherTenant}';
      COMMIT;`)
    f.cleanup()
  })

  describe("ReferenceRate", () => {
    it("refuses a rate outside the band (above 0, below 0.5)", () => {
      expectRejected(reference({ rate: "0" }), "ReferenceRate_rate_band")
      expectRejected(reference({ rate: "0.5" }), "ReferenceRate_rate_band")
      sql(reference({ date: "2026-01-02", rate: "0.499999" }))
    })

    it("refuses a decision by the requester, and a decision without who or when", () => {
      expectRejected(reference({ date: "2026-01-03", status: "APPROVED", decided: userId }), "ReferenceRate_four_eyes")
      expectRejected(reference({ date: "2026-01-04", status: "PENDING", decided: approverId }), "ReferenceRate_decision_shape")
      expectRejected(reference({ date: "2026-01-05", status: "APPROVED", decided: null }), "ReferenceRate_decision_shape")
    })

    it("never changes what was recorded; decides once; never deletes an approved value; never truncates", () => {
      const insert = reference({ date: "2026-01-06" })
      sql(insert)
      const id = idOf(insert)
      for (const set of [`"rate" = 0.2`, `"basis" = 'REPO'`, `"effectiveDate" = '2026-01-07'`, `"tenantId" = '${otherTenant}'`, `"requestedById" = '${approverId}'`]) {
        expectRejected(`UPDATE "ReferenceRate" SET ${set} WHERE "id" = '${id}'`, "value, basis, date, tenant and requester never change")
      }
      expectRejected(`UPDATE "ReferenceRate" SET "status" = 'APPROVED', "decidedById" = '${userId}', "decidedAt" = CURRENT_TIMESTAMP WHERE "id" = '${id}'`, "ReferenceRate_four_eyes")
      sql(approve(id))
      expectRejected(`UPDATE "ReferenceRate" SET "status" = 'REJECTED' WHERE "id" = '${id}'`, "A APPROVED reference rate is immutable")
      expectRejected(`UPDATE "ReferenceRate" SET "decidedAt" = CURRENT_TIMESTAMP WHERE "id" = '${id}'`, "is immutable")
      expectRejected(`DELETE FROM "ReferenceRate" WHERE "id" = '${id}'`, "An approved reference rate is never deleted")
      expectRejected(`BEGIN; TRUNCATE "ReferenceRate"; ROLLBACK;`, "ReferenceRate rows are never truncated")
      const pending = reference({ date: "2026-01-08" })
      sql(pending)
      sql(`DELETE FROM "ReferenceRate" WHERE "id" = '${idOf(pending)}'`)
    })

    it("holds one live value per basis and date; a rejected value does not block its correction", () => {
      const first = reference({ date: "2026-01-09" })
      sql(first)
      expectRejected(reference({ date: "2026-01-09" }), "ReferenceRate_live_key")
      sql(`UPDATE "ReferenceRate" SET "status" = 'REJECTED', "decidedById" = '${approverId}', "decidedAt" = CURRENT_TIMESTAMP WHERE "id" = '${idOf(first)}'`)
      sql(reference({ date: "2026-01-09", rate: "0.118" }))
    })
  })

  describe("ContractRate", () => {
    it("is written only for a NON_NCA asset-finance contract", () => {
      sql(reference({ date: "2025-12-01", status: "APPROVED" }))
      const message = "A contract rate belongs to a NON_NCA asset-finance contract of the same tenant"
      expectRejected(contractRate(loans.nca), message)
      expectRejected(contractRate(loans.plain), message)
      expectRejected(contractRate(loans.nonNca, { tenant: otherTenant }), message)
      sql(contractRate(loans.nonNca))
    })

    it("takes effect at most a year ahead", () => {
      expectRejected(contractRate(loans.nonNca, { basis: "FIXED", date: "2099-01-01" }), "may not take effect more than a year ahead")
      sql(`${contractRate(loans.nonNca, { basis: "FIXED" }).replace("'2026-01-15'", "(current_date + INTERVAL '1 year')::date")}`)
    })

    it("when reference-linked, needs an APPROVED reference of its basis in effect on its date", () => {
      const message = "needs an approved reference rate of its basis in effect on its date"
      expectRejected(contractRate(loans.nonNca, { basis: "REPO", date: "2026-02-01" }), message)
      const pending = reference({ basis: "REPO", date: "2026-01-20" })
      sql(pending)
      expectRejected(contractRate(loans.nonNca, { basis: "REPO", date: "2026-02-01" }), message)
      expectRejected(contractRate(loans.nonNca, { basis: "REPO", date: "2026-01-19" }), message)
      sql(approve(idOf(pending)))
      sql(contractRate(loans.nonNca, { basis: "REPO", date: "2026-02-01" }))
    })

    it("is insert-only: UPDATE, DELETE and TRUNCATE are refused", () => {
      const where = `WHERE "loanId" = '${loans.nonNca}'`
      expectRejected(`UPDATE "ContractRate" SET "resultingRate" = 0.2 ${where}`, "ContractRate is insert-only: UPDATE refused")
      expectRejected(`DELETE FROM "ContractRate" ${where}`, "ContractRate is insert-only: DELETE refused")
      expectRejected(`BEGIN; TRUNCATE "ContractRate"; ROLLBACK;`, "ContractRate is insert-only: TRUNCATE refused")
    })
  })

  describe("tenant-bound foreign keys (migration 20261013100700)", () => {
    const isolated = (trigger: string, table: string, statement: string) =>
      `BEGIN; ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"; ${statement}; ROLLBACK;`

    it("a ContractRate cannot point at another tenant's loan", () => {
      expectRejected(isolated("ContractRate_guard", "ContractRate", contractRate(loans.nonNca, { basis: "FIXED", tenant: otherTenant, date: "2026-03-01" })), "ContractRate_tenantId_loanId_fkey")
    })

    it("a TaxInvoice cannot point at another tenant's loan", () => {
      expectRejected(`INSERT INTO "TaxInvoice" ("id", "tenantId", "number", "invoiceNumber", "issueDate", "supplyDate", "loanId",
        "supplierName", "supplierAddress", "supplierVatNumber", "recipientName", "recipientAddress", "vatRate",
        "totalExclVatCents", "vatCents", "totalInclVatCents")
        VALUES ('inv_x_${token}', '${otherTenant}', 0, '', '2026-10-13', '2026-10-13', '${loans.nonNca}', 'S', 'A', '4000000000',
        'R', 'B', 0.15, 1000, 150, 1150)`, "TaxInvoice_tenantId_loanId_fkey")
    })

    it("a CreditNote cannot credit another tenant's invoice", () => {
      const invoiceId = `inv_${token}`
      sql(`BEGIN;
        INSERT INTO "TaxInvoice" ("id", "tenantId", "number", "invoiceNumber", "issueDate", "supplyDate", "loanId",
          "supplierName", "supplierAddress", "supplierVatNumber", "recipientName", "recipientAddress", "vatRate",
          "totalExclVatCents", "vatCents", "totalInclVatCents")
          VALUES ('${invoiceId}', '${tenantId}', 0, '', '2026-10-13', '2026-10-13', '${loans.nonNca}', 'S', 'A', '4000000000',
          'R', 'B', 0.15, 1000, 150, 1150);
        INSERT INTO "TaxInvoiceLine" ("id", "invoiceId", "lineNo", "description", "quantity", "unitExclVatCents", "exclVatCents", "vatCents", "inclVatCents")
          VALUES ('line_${token}', '${invoiceId}', 1, 'Test asset', 1, 1000, 1000, 150, 1150);
        COMMIT;`)
      expectRejected(isolated("CreditNote_assign_number", "CreditNote", `INSERT INTO "CreditNote"
        ("id", "tenantId", "number", "creditNoteNumber", "issueDate", "invoiceId", "reason", "exclVatCents", "vatCents", "inclVatCents")
        VALUES ('cn_x_${token}', '${otherTenant}', 1, 'CN-000001', '2026-10-14', '${invoiceId}', 'Test', 100, 15, 115)`), "CreditNote_tenantId_invoiceId_fkey")
    })
  })
})
