/**
 * Real-Postgres proof of the rate-table rules: ReferenceRate born PENDING,
 * four-eyes, decision completeness, tenant-bound requester and decider, band,
 * immutability and live-value uniqueness (migration 20261013100000);
 * the decision time stamped by the database; ContractRate insert-only with its
 * insert rules: fixed = resulting, reference + margin = resulting, never
 * backdated, basis and margin kept (20261013100500); and the
 * tenant-bound composite foreign keys of ContractRate, TaxInvoice and
 * CreditNote (20261013100700), each isolated from the trigger that would
 * otherwise refuse the row first.
 *
 *   RUN_ASSET_FINANCE_RATES_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/rates-db.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { afSqlFixture, expectRejected, idOf, sql } from "./af-sql.integration-fixture"

const RUN = process.env.RUN_ASSET_FINANCE_RATES_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("asset finance rate tables and tenant keys (real DB)", () => {
  const f = afSqlFixture("afr")
  const { tenantId, entityId, userId, approverId, token } = f.ids
  const otherTenant = `tenant_afr2_${token}`
  const otherUser = `user_afr2_${token}`
  let seq = 0
  const loans = { nonNca: "", plain: "", nca: "", fresh: "", race: "", repo: "" }

  const reference = (over: { date?: string; rate?: string; status?: string; decided?: string | null; basis?: string; requester?: string } = {}) => {
    seq += 1
    const decided = over.decided ?? null
    const id = `rr_${token}_${seq}`
    return `INSERT INTO "ReferenceRate" ("id", "tenantId", "basis", "effectiveDate", "rate", "status", "requestedById", "decidedById", "decidedAt")
      VALUES ('${id}', '${tenantId}', '${over.basis ?? "PRIME"}', '${over.date ?? "2026-01-15"}', ${over.rate ?? "0.1175"},
      '${over.status ?? "PENDING"}', '${over.requester ?? userId}', ${decided ? `'${decided}'` : "NULL"}, ${decided ? "CURRENT_TIMESTAMP" : "NULL"})`
  }
  const approve = (id: string, decider = approverId) =>
    `UPDATE "ReferenceRate" SET "status" = 'APPROVED', "decidedById" = '${decider}', "decidedAt" = CURRENT_TIMESTAMP WHERE "id" = '${id}'`
  /** Recorded by the fixture user, approved by the second: the only way to an APPROVED value. */
  const approved = (over: { date?: string; rate?: string; basis?: string }) => {
    const insert = reference(over)
    sql(`${insert}; ${approve(idOf(insert))}`)
  }
  const contractRate = (loanId: string, over: { date?: string; basis?: string; tenant?: string; rate?: string; fixed?: string; margin?: string } = {}) => {
    seq += 1
    const fixed = over.basis === "FIXED"
    const rate = over.rate ?? "0.1275"
    return `INSERT INTO "ContractRate" ("id", "tenantId", "loanId", "effectiveDate", "basis", "margin", "fixedRate", "resultingRate")
      VALUES ('cr_${token}_${seq}', '${over.tenant ?? tenantId}', '${loanId}', '${over.date ?? "2026-01-15"}', '${over.basis ?? "PRIME"}',
      ${fixed ? `NULL, ${over.fixed ?? rate}` : `${over.margin ?? "0.01"}, NULL`}, ${rate})`
  }

  beforeAll(() => {
    f.seed()
    sql(`INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('${otherTenant}', 'afr2-${token}', 'AF other', CURRENT_TIMESTAMP);
      INSERT INTO "User" ("id", "tenantId", "email", "password", "updatedAt")
        VALUES ('${otherUser}', '${otherTenant}', 'afr2-${token}@test.invalid', 'x', CURRENT_TIMESTAMP)`)
    const book = (contractType: string, start?: string) => {
      const app = f.nonNcaApplication()
      sql(f.approveApplication(app))
      const loan = f.loan(app, { entityId }, "NON_NCA", undefined, start).replace("'INSTALMENT_SALE', CURRENT_TIMESTAMP)", `'${contractType}', CURRENT_TIMESTAMP)`)
      sql(`${loan}; ${f.disburse(app)}`)
      return idOf(loan)
    }
    loans.nonNca = book("INSTALMENT_SALE", "'2026-01-01 10:00:00'::timestamp")
    loans.plain = book("LOAN")
    // 23:00 UTC on 31 May is 01:00 SAST on 1 June: the start DATE is 1 June.
    loans.fresh = book("INSTALMENT_SALE", "'2026-05-31 23:00:00'::timestamp")
    loans.race = book("INSTALMENT_SALE", "'2026-01-01 10:00:00'::timestamp")
    loans.repo = book("INSTALMENT_SALE", "'2026-01-01 10:00:00'::timestamp")
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
      DELETE FROM "ContractRate" WHERE "tenantId" IN ('${tenantId}', '${otherTenant}');
      DELETE FROM "ReferenceRate" WHERE "tenantId" IN ('${tenantId}', '${otherTenant}');
      DELETE FROM "User" WHERE "id" = '${otherUser}';
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

    it("is born PENDING and undecided: an INSERT that arrives decided is refused", () => {
      const message = "A reference rate is recorded PENDING and undecided"
      expectRejected(reference({ date: "2026-01-03", status: "APPROVED", decided: approverId }), message)
      expectRejected(reference({ date: "2026-01-03", status: "REJECTED", decided: approverId }), message)
      expectRejected(reference({ date: "2026-01-03", decided: approverId }), message)
      expectRejected(reference({ date: "2026-01-03" }).replace(/NULL\)$/, "CURRENT_TIMESTAMP)"), message)
    })

    it("refuses a decision by the requester, a decision without a decider, and a decider on a PENDING row", () => {
      const insert = reference({ date: "2026-01-04" })
      sql(insert)
      const where = `WHERE "id" = '${idOf(insert)}'`
      expectRejected(approve(idOf(insert), userId), "ReferenceRate_four_eyes")
      expectRejected(`UPDATE "ReferenceRate" SET "status" = 'APPROVED' ${where}`, "ReferenceRate_decision_complete")
      expectRejected(`UPDATE "ReferenceRate" SET "status" = 'REJECTED', "decidedAt" = CURRENT_TIMESTAMP ${where}`, "ReferenceRate_decision_complete")
      expectRejected(`UPDATE "ReferenceRate" SET "decidedById" = '${approverId}', "decidedAt" = CURRENT_TIMESTAMP ${where}`, "ReferenceRate_decision_complete")
    })

    it("stamps decidedAt with the database clock at the decision: a backdated or missing value is replaced", () => {
      const lagSeconds = (id: string) => Number(sql(`SELECT extract(epoch FROM (clock_timestamp() AT TIME ZONE 'UTC') - "decidedAt")
        FROM "ReferenceRate" WHERE "id" = '${id}'`))
      const backdated = reference({ basis: "JIBAR", date: "2026-01-04" })
      const missing = reference({ basis: "JIBAR", date: "2026-01-05" })
      sql(`${backdated}; ${missing}`)
      sql(`UPDATE "ReferenceRate" SET "status" = 'APPROVED', "decidedById" = '${approverId}', "decidedAt" = '2020-01-01 00:00:00'
        WHERE "id" = '${idOf(backdated)}'`)
      sql(`UPDATE "ReferenceRate" SET "status" = 'REJECTED', "decidedById" = '${approverId}' WHERE "id" = '${idOf(missing)}'`)
      for (const id of [idOf(backdated), idOf(missing)]) {
        expect(lagSeconds(id)).toBeGreaterThanOrEqual(0)
        expect(lagSeconds(id)).toBeLessThan(60)
      }
    })

    it("requester and decider are users of the row's own tenant", () => {
      expectRejected(reference({ date: "2026-01-05", requester: otherUser }), "ReferenceRate_tenantId_requestedById_fkey")
      expectRejected(reference({ date: "2026-01-05", requester: `no_such_user_${token}` }), "ReferenceRate_tenantId_requestedById_fkey")
      const insert = reference({ date: "2026-01-05" })
      sql(insert)
      expectRejected(approve(idOf(insert), otherUser), "ReferenceRate_tenantId_decidedById_fkey")
    })

    it("never changes what was recorded; decides once; never deletes an approved value; never truncates", () => {
      const insert = reference({ date: "2026-01-06" })
      sql(insert)
      const id = idOf(insert)
      for (const set of [`"rate" = 0.2`, `"basis" = 'REPO'`, `"effectiveDate" = '2026-01-07'`, `"tenantId" = '${otherTenant}'`, `"requestedById" = '${approverId}'`]) {
        expectRejected(`UPDATE "ReferenceRate" SET ${set} WHERE "id" = '${id}'`, "value, basis, date, tenant and requester never change")
      }
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
      approved({ date: "2025-12-01" })
      const message = "A contract rate belongs to a NON_NCA asset-finance contract of the same tenant"
      expectRejected(contractRate(loans.nca), message)
      expectRejected(contractRate(loans.plain), message)
      expectRejected(contractRate(loans.nonNca, { tenant: otherTenant }), message)
      sql(contractRate(loans.nonNca))
    })

    it("a fixed rate is its own resulting rate (CHECK)", () => {
      // On a loan with no contract rate yet, so the trigger's continuity rule does not refuse it first.
      expectRejected(contractRate(loans.race, { basis: "FIXED", date: "2026-01-20", fixed: "0.13", rate: "0.1275" }), "ContractRate_fixed_resulting_rate")
    })

    it("when reference-linked, needs an APPROVED reference of its basis in effect on its date", () => {
      const message = "needs an approved reference rate of its basis in effect on its date"
      expectRejected(contractRate(loans.repo, { basis: "REPO", date: "2026-02-01" }), message)
      const pending = reference({ basis: "REPO", date: "2026-01-20" })
      sql(pending)
      expectRejected(contractRate(loans.repo, { basis: "REPO", date: "2026-02-01" }), message)
      expectRejected(contractRate(loans.repo, { basis: "REPO", date: "2026-01-19" }), message)
      sql(approve(idOf(pending)))
      sql(contractRate(loans.repo, { basis: "REPO", date: "2026-02-01" }))
    })

    it("when reference-linked, its resulting rate is exactly the reference IN FORCE on its date plus the margin", () => {
      approved({ date: "2026-02-15", rate: "0.12" })
      const message = "resulting rate must be the approved PRIME rate in force on its date (0.120000) plus its margin"
      expectRejected(contractRate(loans.nonNca, { date: "2026-03-01", rate: "0.1275" }), message) // an older approved value + margin
      expectRejected(contractRate(loans.nonNca, { date: "2026-03-01", rate: "0.130001" }), message)
      sql(contractRate(loans.nonNca, { date: "2026-03-01", rate: "0.13" }))
    })

    it("never takes effect before the loan's latest contract rate, nor (the first) before its SAST start date", () => {
      expectRejected(contractRate(loans.nonNca, { basis: "FIXED", date: "2026-02-20" }), "may not take effect before 2026-03-01 (the loan's latest contract rate)")
      expectRejected(contractRate(loans.fresh, { basis: "FIXED", date: "2026-05-31" }), "may not take effect before 2026-06-01 (the loan's start date)")
      sql(contractRate(loans.fresh, { basis: "FIXED", date: "2026-06-01" }))
      // The same date passes the guard to the unique index (repricing reads its P2002 as already_repriced).
      expectRejected(contractRate(loans.fresh, { basis: "FIXED", date: "2026-06-01" }), "ContractRate_loanId_effectiveDate_key")
    })

    it("keeps the loan's basis and margin (or fixed rate): only the resulting rate moves; a variation is refused", () => {
      const VARIATION = "keeps the loan's basis and margin (or fixed rate) of 2026-03-01: a change is a contract variation"
      // nonNca: PRIME + 0.01 from 2026-03-01; PRIME 0.12, REPO 0.1175 approved.
      expectRejected(contractRate(loans.nonNca, { date: "2026-03-15", margin: "0.02", rate: "0.14" }), VARIATION)
      expectRejected(contractRate(loans.nonNca, { basis: "REPO", date: "2026-03-15" }), VARIATION)
      expectRejected(contractRate(loans.nonNca, { basis: "FIXED", date: "2026-03-15", rate: "0.13" }), VARIATION)
      sql(contractRate(loans.nonNca, { date: "2026-03-15", margin: "0.010000", rate: "0.13" }))
      // fresh: FIXED 0.1275 from 2026-06-01.
      const FIXED_VARIATION = VARIATION.replace("2026-03-01", "2026-06-01")
      expectRejected(contractRate(loans.fresh, { basis: "FIXED", date: "2026-07-01", rate: "0.14" }), FIXED_VARIATION)
      expectRejected(contractRate(loans.fresh, { date: "2026-07-01", rate: "0.13" }), FIXED_VARIATION)
    })

    it("takes effect at most a year ahead", () => {
      expectRejected(contractRate(loans.fresh, { basis: "FIXED", date: "2099-01-01" }), "may not take effect more than a year ahead")
      sql(`${contractRate(loans.fresh, { basis: "FIXED" }).replace("'2026-01-15'", "(current_date + INTERVAL '1 year')::date")}`)
    })

    it("two concurrent inserts for one loan queue: the earlier-dated one sees the later one and is refused", async () => {
      const [a, b] = [new PrismaClient(), new PrismaClient()]
      try {
        let release: () => void = () => undefined
        const held = new Promise<void>((resolve) => { release = resolve })
        const later = a.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(contractRate(loans.race, { basis: "FIXED", date: "2026-04-01" }))
          await held
        }, { timeout: 20_000 })
        await new Promise((resolve) => setTimeout(resolve, 300))
        // Settled to a value at once, so its rejection is never unhandled.
        const earlier = b.$executeRawUnsafe(contractRate(loans.race, { basis: "FIXED", date: "2026-03-01" })).then(() => "accepted", String)
        await new Promise((resolve) => setTimeout(resolve, 300))
        release()
        await later
        expect(await earlier).toContain("may not take effect before 2026-04-01 (the loan's latest contract rate)")
      } finally {
        await Promise.all([a.$disconnect(), b.$disconnect()])
      }
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
      expectRejected(isolated("ContractRate_guard", "ContractRate", contractRate(loans.nonNca, { basis: "FIXED", tenant: otherTenant, date: "2026-09-01" })), "ContractRate_tenantId_loanId_fkey")
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
