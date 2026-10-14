/**
 * The lease ledger's SQL rules (migration 20261014090000), case by case, each
 * red when its rule is removed: a lease loan exists only as its BOOKED deal
 * booked it; a lease deal is never deleted; every schedule row of a lease is
 * a rental and agrees with it, due date included; a rental is written
 * uninvoiced, invoiced once, supplied no later than its due date (earlier
 * only once paid), never moved to a non-lease loan, never truncated, and its
 * amounts change only inside a recorded repricing at the booked VAT rate; a
 * booked lease deal is frozen; booking refuses a CPA scope or balloon that is
 * not the deal's. Rows come from the real routes (lease.integration-fixture.ts).
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-rental-rules.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { expectRejected, sql } from "./af-sql.integration-fixture"
import { cleanupDealFixture, dealFixtureTenantId, dealRoutes } from "./deal.integration-fixture"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { deal: "", loan: "", app: "", asset: "", approvedApp: "", approved: "", rental: "", rental2: "", schedule: "", draft: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const loanInsert = (id: string, app: string, contractType: string, asset: string | null) => `INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId",
  "entityId", "productId", "principal", "totalInterest", "initiationFee", "totalRepayable", "outstandingPrincipal", "startDate", "maturityDate", "interestRatePm",
  "interestModel", "ncaRegime", "contractType", "assetId", "cpaApplies", "cpaRule", "updatedAt")
  VALUES ('${id}', '${fx.tenantId}', '${id}', '${app}', '${fx.evidenced}', '${fx.product}', 5000000, 0, 0, 5000000, 5000000, now(), now() + INTERVAL '1 year',
  0.05, 'REDUCING_BALANCE', 'NON_NCA', '${contractType}', ${asset ? `'${asset}'` : "NULL"}, false, 'CPA_JURISTIC_OVER_THRESHOLD', now())`
const invoice = (id: string, loan: string, total: number, supply: string) => `INSERT INTO "TaxInvoice" ("id", "tenantId", "number", "invoiceNumber",
  "issueDate", "supplyDate", "loanId", "supplierName", "supplierAddress", "supplierVatNumber", "recipientName", "recipientAddress", "vatRate",
  "totalExclVatCents", "vatCents", "totalInclVatCents")
  VALUES ('${id}', '${fx.tenantId}', 0, '', CURRENT_DATE, ${supply}, '${loan}', 'L', 'A', '4000000001', 'R', 'A', 0.15, ${total}, 0, ${total})`
const withoutTotals = (statement: string) => `BEGIN; ALTER TABLE "TaxInvoice" DISABLE TRIGGER "TaxInvoice_totals_match_lines"; ${statement}; ROLLBACK;`

suite.sequential("lease ledger SQL rules (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    ids.deal = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[0], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced }))
    await signLease(fx, database(), setSession, ids.deal)
    ids.loan = await payoutAndBook(fx, database(), staff, ids.deal)
    const loan = await database().loan.findUniqueOrThrow({ where: { id: ids.loan } })
    ids.app = loan.applicationId
    ids.asset = loan.assetId ?? ""
    ids.approved = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced }))
    ids.approvedApp = (await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: ids.approved } })).applicationId
    staff(fx.officer, "CREDIT_OFFICER")
    const draft = await dealRoutes(fx.host).create(leaseBody(fx, { assetId: fx.assets[2], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced }))
    ids.draft = ((await draft.json()) as { id: string }).id
    const [first, second] = await database().leaseRental.findMany({ where: { loanId: ids.loan }, orderBy: { periodNo: "asc" }, take: 2 })
    ids.rental = first.id
    ids.rental2 = second.id
    ids.schedule = first.scheduleId
  }, 300_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  describe("a lease loan is its booked deal's", () => {
    // As the breaker did: the application moves to DISBURSED with the loan, so the credit-life commit rule is satisfied.
    const disburse = `UPDATE "LoanApplication" SET "status" = 'DISBURSED', "disbursedAt" = now() WHERE "id" = '__APP__'`
    it("refuses a lease loan written on an approved but unbooked lease application (breaker: cash loan labelled a lease)", () => {
      expectRejected(`${loanInsert(`loan_a_${t}`, ids.approvedApp, "OPERATING_LEASE", fx.assets[1])}; ${disburse.replace("__APP__", ids.approvedApp)}`, "A lease loan is booked by its lease deal")
    })
    it("refuses a lease loan with no asset", () => {
      expectRejected(`${loanInsert(`loan_b_${t}`, ids.approvedApp, "OPERATING_LEASE", null)}; ${disburse.replace("__APP__", ids.approvedApp)}`, "A lease loan is booked by its lease deal")
    })
    it("refuses moving a lease deal off its application, orphaning a NON_NCA lease application (breaker round 2)", () => {
      const app = `app_o_${t}`
      expectRejected(`INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "entityId", "productId", "appliedAmount", "appliedTermDays", "ncaRegime",
          "ncaClassificationRule", "ncaClassifiedAt", "ncaClassifiedById", "updatedAt") VALUES ('${app}', '${fx.tenantId}', '${app}', '${fx.evidenced}',
          '${fx.product}', 100000000, 1095, 'NON_NCA', 'LEASE_NOT_CREDIT_AGREEMENT', now(), '${fx.officer}', now());
        UPDATE "AssetFinanceDeal" SET "applicationId" = '${app}' WHERE "id" = '${ids.draft}'`, "only a lease deal's is")
    })
    it("refuses deleting a lease deal (its application's lease rule rests on it)", () => {
      expectRejected(`DELETE FROM "AssetFinanceDeal" WHERE "id" = '${ids.approved}'`, "A lease deal is never deleted")
    })
    it("a booked lease deal is frozen: its residual, timing and penalty are what was booked", () => {
      for (const set of [`"balloonCents" = 1`, `"rentalTiming" = 'ADVANCE'`, `"earlyTerminationPenaltyRate" = 0.5`]) {
        expectRejected(`UPDATE "AssetFinanceDeal" SET ${set} WHERE "id" = '${ids.deal}'`, "A booked deal is immutable")
      }
    })
  })

  describe("schedule rows are rentals", () => {
    it("refuses a rental and its schedule row added after booking (breaker round 2)", () => {
      expectRejected(`INSERT INTO "RepaymentSchedule" ("id", "tenantId", "loanId", "installmentNo", "dueDate", "principalDue", "interestDue", "feesDue", "totalDue")
          VALUES ('rs_y_${t}', '${fx.tenantId}', '${ids.loan}', 99, now() + INTERVAL '5 years', 100, 0, 0, 100);
        INSERT INTO "LeaseRental" ("id", "tenantId", "loanId", "scheduleId", "periodNo", "dueDate", "rentalExclVatCents", "maintenanceExclVatCents",
          "vatCents", "totalCents", "vatRate") VALUES ('lr_y_${t}', '${fx.tenantId}', '${ids.loan}', 'rs_y_${t}', 99,
          ((now() + INTERVAL '5 years') AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date, 100, 0, 0, 100, 0.15)`, "written when it is booked")
    })
    it("refuses an extra schedule row on a lease loan (breaker: billed with no rental)", () => {
      expectRejected(`INSERT INTO "RepaymentSchedule" ("id", "tenantId", "loanId", "installmentNo", "dueDate", "principalDue", "interestDue", "feesDue", "totalDue")
        VALUES ('rs_x_${t}', '${fx.tenantId}', '${ids.loan}', 99, now(), 9999999, 0, 0, 9999999)`, "schedule row is one of its rentals")
    })
    it("refuses moving a schedule row's due date away from its rental's (breaker: drift)", () => {
      expectRejected(`UPDATE "RepaymentSchedule" SET "dueDate" = "dueDate" + INTERVAL '200 days' WHERE "id" = '${ids.schedule}'`, "same due date")
    })
  })

  describe("rental amounts change only inside a recorded repricing", () => {
    const flagged = (extra: string, set: string) => `BEGIN; SELECT set_config('credaflow.lease_reprice', 'on', true); ${extra}
      UPDATE "LeaseRental" SET ${set} WHERE "id" = '${ids.rental2}'; SELECT "rentalExclVatCents" FROM "LeaseRental" WHERE "id" = '${ids.rental2}'; ROLLBACK;`
    // A real repricing record: a new APPROVED PRIME (four-eyes) and the contract rate it moves to, written in this transaction.
    const contractRate = (rate = "0.1250", days = 11) => {
      const ref = `rr_x_${randomUUID()}`
      return `INSERT INTO "ReferenceRate" ("id", "tenantId", "basis", "effectiveDate", "rate", "requestedById")
          VALUES ('${ref}', '${fx.tenantId}', 'PRIME', CURRENT_DATE + ${days}, ${rate}, '${fx.adminA}');
        UPDATE "ReferenceRate" SET "status" = 'APPROVED', "decidedById" = '${fx.adminB}', "decidedAt" = now() WHERE "id" = '${ref}';
        INSERT INTO "ContractRate" ("id", "tenantId", "loanId", "effectiveDate", "basis", "margin", "resultingRate", "newInstalmentCents")
          SELECT 'cr_x_${randomUUID()}', "tenantId", "loanId", CURRENT_DATE + ${days}, "basis", "margin", ${rate} + "margin", "newInstalmentCents" FROM "ContractRate"
          WHERE "loanId" = '${ids.loan}' ORDER BY "effectiveDate" DESC LIMIT 1;`
    }
    const sameRate = () => `INSERT INTO "ContractRate" ("id", "tenantId", "loanId", "effectiveDate", "basis", "margin", "resultingRate", "newInstalmentCents")
      SELECT 'cr_s_${randomUUID()}', "tenantId", "loanId", CURRENT_DATE + 7, "basis", "margin", "resultingRate", 1 FROM "ContractRate"
      WHERE "loanId" = '${ids.loan}' ORDER BY "effectiveDate" DESC LIMIT 1;`
    const vat = (rental: string) => `"vatHalfUpCents"(${rental}, "vatRate") + "vatHalfUpCents"("maintenanceExclVatCents", "vatRate")`
    const repriced = (rental: string) => `"rentalExclVatCents" = ${rental}, "vatCents" = ${vat(rental)}, "totalCents" = ${rental} + "maintenanceExclVatCents" + ${vat(rental)}`
    it("refuses the flag alone, set by any writer, with no repricing recorded in the transaction (breaker)", () => {
      expectRejected(flagged("", repriced(`"rentalExclVatCents" - 1000`)), "only a repricing changes them")
    })
    it("refuses a dummy contract rate at the same rate (breaker round 2)", () => {
      expectRejected(flagged(sameRate(), repriced(`"rentalExclVatCents" - 1000`)), "only a repricing changes them")
    })
    it("refuses a contract rate from an earlier transaction, whatever its createdAt says (breaker round 2)", () => {
      // Committed earlier (and dated in the future, as the breaker forged it): it unlocks nothing later.
      sql(`BEGIN; ${contractRate("0.1300", 9).replace(`INSERT INTO "ContractRate" ("id",`, `INSERT INTO "ContractRate" ("createdAt", "id",`).replace(`SELECT 'cr_x_`, `SELECT '2099-01-01', 'cr_x_`)} COMMIT;`)
      expectRejected(flagged("", repriced(`"rentalExclVatCents" - 1000`)), "only a repricing changes them")
    })
    it("with a recorded repricing: admits the new rental and its recomputed VAT, refuses a changed VAT rate or a VAT not recomputed", async () => {
      const out = sql(flagged(contractRate(), repriced(`"rentalExclVatCents" - 1000`)))
      const before = await database().leaseRental.findUniqueOrThrow({ where: { id: ids.rental2 } })
      expect(out).toContain(String(before.rentalExclVatCents - 1000))
      expectRejected(flagged(contractRate(), `"vatRate" = 0, "vatCents" = 0, "totalCents" = "rentalExclVatCents" + "maintenanceExclVatCents"`), "keeps its booked VAT rate")
      expectRejected(flagged(contractRate(), `"rentalExclVatCents" = "rentalExclVatCents" - 1000, "totalCents" = "totalCents" - 1000`), "keeps its booked VAT rate")
    })
  })

  describe("rental invoices", () => {
    it("a rental is written uninvoiced and never on a non-lease loan", () => {
      const insert = (invoiceId: string) => `INSERT INTO "LeaseRental" ("id", "tenantId", "loanId", "scheduleId", "periodNo", "dueDate", "rentalExclVatCents",
        "maintenanceExclVatCents", "vatCents", "totalCents", "vatRate", "taxInvoiceId") VALUES ('lr_x_${randomUUID()}', '${fx.tenantId}', '${ids.loan}',
        '${ids.schedule}', 98, CURRENT_DATE, 100, 0, 0, 100, 0.15, ${invoiceId})`
      expectRejected(withoutTotals(`${invoice(`inv_w_${t}`, ids.loan, 100, "CURRENT_DATE")}; ${insert(`'inv_w_${t}'`)}`), "written uninvoiced")
      expectRejected(`TRUNCATE "LeaseRental"`, "never deleted")
    })
    it("supplied no later than the due date, earlier only once money reached it (breaker)", async () => {
      const rental = await database().leaseRental.findUniqueOrThrow({ where: { id: ids.rental2 } })
      const bind = (id: string, supply: string) => withoutTotals(`${invoice(id, ids.loan, rental.totalCents, supply)};
        UPDATE "LeaseRental" SET "taxInvoiceId" = '${id}' WHERE "id" = '${ids.rental2}'`)
      expectRejected(bind(`inv_e_${t}`, "CURRENT_DATE"), "earlier only once a payment has reached it")
      // After the due date: the rental (and its schedule row) moved into the past inside the rolled-back transaction.
      const past = `SET LOCAL session_replication_role = replica;
        UPDATE "LeaseRental" SET "dueDate" = CURRENT_DATE - 5 WHERE "id" = '${ids.rental2}';
        SET LOCAL session_replication_role = origin;`
      expectRejected(bind(`inv_l_${t}`, "CURRENT_DATE").replace("ALTER TABLE", `${past} ALTER TABLE`), "earlier only once a payment has reached it")
    })
    it("refuses an early invoice resting on a faked paid amount with no receipt (breaker round 2)", async () => {
      const rental = await database().leaseRental.findUniqueOrThrow({ where: { id: ids.rental2 } })
      expectRejected(withoutTotals(`UPDATE "RepaymentSchedule" SET "totalPaid" = 1 WHERE "id" = '${rental.scheduleId}';
        ${invoice(`inv_f_${t}`, ids.loan, rental.totalCents, "CURRENT_DATE")};
        UPDATE "LeaseRental" SET "taxInvoiceId" = 'inv_f_${t}' WHERE "id" = '${ids.rental2}'`), "earlier only once a payment has reached it")
    })

    it("the invoice is set once", () => {
      expectRejected(`BEGIN; ALTER TABLE "TaxInvoice" DISABLE TRIGGER "TaxInvoice_totals_match_lines";
        ${invoice(`inv_a_${t}`, ids.loan, 1, "CURRENT_DATE")}; ${invoice(`inv_b_${t}`, ids.loan, 1, "CURRENT_DATE")};
        SET LOCAL session_replication_role = replica;
        UPDATE "LeaseRental" SET "taxInvoiceId" = 'inv_a_${t}' WHERE "id" = '${ids.rental}';
        SET LOCAL session_replication_role = origin;
        UPDATE "LeaseRental" SET "taxInvoiceId" = 'inv_b_${t}' WHERE "id" = '${ids.rental}'; ROLLBACK;`, "tax invoice is set once")
    })
  })

  describe("booking carries the deal's terms", () => {
    const booked = (set: string) => `BEGIN; SET LOCAL session_replication_role = replica;
      UPDATE "AssetFinanceDeal" SET "status" = 'CONTRACTED' WHERE "id" = '${ids.deal}'; ${set};
      SET LOCAL session_replication_role = origin;
      ALTER TABLE "AssetFinanceDeal" DISABLE TRIGGER "AssetFinanceDeal_status_transitions";
      ALTER TABLE "AssetFinanceDeal" DISABLE TRIGGER "AssetFinanceDeal_booking_gate";
      ALTER TABLE "AssetFinanceDeal" DISABLE TRIGGER "AssetFinanceDeal_booked_by_planned_start";
      UPDATE "AssetFinanceDeal" SET "status" = 'BOOKED' WHERE "id" = '${ids.deal}'; ROLLBACK;`
    it.each([
      [`UPDATE "Loan" SET "cpaApplies" = true, "cpaRule" = 'CPA_FINANCIALS_UNPROVEN' WHERE "id" = '__LOAN__'`],
      [`UPDATE "Loan" SET "balloonAmount" = 30000000 WHERE "id" = '__LOAN__'`],
    ])("refuses %s", (set) => {
      expectRejected(booked(set.replace("__LOAN__", ids.loan)), "deal''s CPA scope on the loan, no balloon".replace("''", "'"))
    })
  })
})
