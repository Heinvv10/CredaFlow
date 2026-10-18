/**
 * Every hand-written SQL rule of migration 20261014090000_asset_finance_lease_foundation
 * has a case here that goes red when the rule is removed. Rows come from the
 * real routes (lease.integration-fixture.ts); each violation is attempted with
 * psql so the database's own constraint names and messages are asserted. A
 * CHECK is isolated from the triggers with session_replication_role =
 * replica (which disables triggers but never CHECKs); a trigger that an
 * earlier trigger would pre-empt is isolated by disabling that one trigger
 * inside a rolled-back transaction.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-foundation.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { expectRejected, sql } from "./af-sql.integration-fixture"
import { cleanupDealFixture, dealFixtureTenantId, dealRoutes } from "./deal.integration-fixture"
import { addMonthsClamped } from "./dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { draft: "", draftApp: "", approved: "", approvedApp: "", fmlLoan: "", fmlDeal: "", olLoan: "", olApp: "", rental: "", otherInvoice: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const replica = (statement: string) => `BEGIN; SET LOCAL session_replication_role = replica; ${statement}; COMMIT;`
const without = (table: string, trigger: string, statement: string) =>
  `BEGIN; ALTER TABLE "${table}" DISABLE TRIGGER "${trigger}"; ${statement}; ROLLBACK;`

suite.sequential("lease foundation SQL rules (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    staff(fx.officer, "CREDIT_OFFICER")
    const created = await dealRoutes(fx.host).create(leaseBody(fx, {
      assetId: fx.assets[3], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced,
    }))
    ids.draft = ((await created.json()) as { id: string }).id
    ids.draftApp = (await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: ids.draft } })).applicationId
    ids.fmlDeal = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[0], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced }))
    await signLease(fx, database(), setSession, ids.fmlDeal)
    ids.fmlLoan = await payoutAndBook(fx, database(), staff, ids.fmlDeal)
    const firstDue = addMonthsClamped(sastCalendarDate(new Date()), 1)
    const olDeal = await approveLease(fx, staff, leaseBody(fx, {
      assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", clientId: fx.lessee, firstDueDate: firstDue,
    }))
    await signLease(fx, database(), setSession, olDeal, firstDue)
    ids.olLoan = await payoutAndBook(fx, database(), staff, olDeal)
    ids.olApp = (await database().loan.findUniqueOrThrow({ where: { id: ids.olLoan } })).applicationId
    ids.approved = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[2], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced }))
    ids.approvedApp = (await database().assetFinanceDeal.findUniqueOrThrow({ where: { id: ids.approved } })).applicationId
    ids.rental = (await database().leaseRental.findFirstOrThrow({ where: { loanId: ids.fmlLoan, periodNo: 1 } })).id
  }, 300_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  describe("deal lease terms and CPA scope (CHECKs)", () => {
    const update = (set: string) => replica(`UPDATE "AssetFinanceDeal" SET ${set} WHERE "id" = '${ids.draft}'`)
    it.each([
      [`"rentalTiming" = NULL`, "AssetFinanceDeal_lease_terms_shape"],
      [`"maintenanceMonthlyExclVatCents" = NULL`, "AssetFinanceDeal_lease_terms_shape"],
      [`"depositCents" = 100`, "AssetFinanceDeal_lease_terms_shape"],
      [`"tradeInCents" = 100`, "AssetFinanceDeal_lease_terms_shape"],
      [`"financedFeesCents" = 100`, "AssetFinanceDeal_lease_terms_shape"],
      [`"vatDeferralPeriodIndex" = 1`, "AssetFinanceDeal_lease_terms_shape"],
      [`"maintenanceRiskModel" = NULL`, "AssetFinanceDeal_lease_terms_shape"],
      [`"earlyTerminationPenaltyRate" = NULL`, "AssetFinanceDeal_lease_terms_shape"],
      [`"usageAllowancePerYear" = NULL, "usageUnit" = NULL, "excessRateCents" = NULL`, "AssetFinanceDeal_lease_terms_shape"], // an FML has contracted usage
      [`"usageUnit" = NULL`, "AssetFinanceDeal_lease_terms_shape"],
      [`"contractType" = 'OPERATING_LEASE'`, "AssetFinanceDeal_lease_terms_shape"], // an operating lease carries no maintenance
      [`"escalationRate" = 1`, "AssetFinanceDeal_lease_terms_range"],
      [`"excessRateCents" = 0`, "AssetFinanceDeal_lease_terms_range"],
      [`"maintenanceEscalationRate" = 1`, "AssetFinanceDeal_lease_terms_range"],
      [`"earlyTerminationPenaltyRate" = 1`, "AssetFinanceDeal_lease_terms_range"],
      [`"maintenanceMonthlyExclVatCents" = 0`, "AssetFinanceDeal_lease_terms_range"],
      [`"usageAllowancePerYear" = 0`, "AssetFinanceDeal_lease_terms_range"],
      [`"cpaRule" = 'CPA_MADE_UP'`, "AssetFinanceDeal_cpa_scope_shape"],
      [`"cpaApplies" = NOT "cpaApplies"`, "AssetFinanceDeal_cpa_scope_shape"],
      [`"cpaApplies" = NULL, "cpaRule" = NULL`, "AssetFinanceDeal_cpa_scope_shape"],
    ])("%s → %s", (set, constraint) => expectRejected(update(set), constraint))

    it("an instalment sale carries no lease column", () => {
      expectRejected(replica(`UPDATE "AssetFinanceDeal" SET "contractType" = 'INSTALMENT_SALE', "maintenanceMonthlyExclVatCents" = NULL,
        "maintenanceEscalationRate" = NULL, "maintenanceRiskModel" = NULL, "usageAllowancePerYear" = NULL, "usageUnit" = NULL,
        "excessRateCents" = NULL, "cpaApplies" = NULL, "cpaRule" = NULL, "cpaEvidenceIds" = ARRAY[]::TEXT[] WHERE "id" = '${ids.draft}'`), "AssetFinanceDeal_lease_terms_shape")
    })

    it("planned start: before the first due date, except a lease in advance, which starts on it", () => {
      const start = (deal: string, expr: string) => replica(`UPDATE "AssetFinanceDeal" SET "plannedStartDate" = ${expr} WHERE "id" = '${deal}'`)
      expectRejected(start(ids.approved, `"firstDueDate"`), "AssetFinanceDeal_planned_start_before_first_due") // arrears
      sql(replica(`UPDATE "AssetFinanceDeal" SET "rentalTiming" = 'ADVANCE' WHERE "id" = '${ids.approved}'`))
      expectRejected(start(ids.approved, `"firstDueDate" - 1`), "AssetFinanceDeal_planned_start_before_first_due")
      sql(replica(`UPDATE "AssetFinanceDeal" SET "rentalTiming" = 'ARREARS' WHERE "id" = '${ids.approved}'`))
    })

    it.each([
      [`"earlyTerminationPenaltyRate" = 0.2`], [`"cpaEvidenceIds" = ARRAY['x']`], [`"rentalTiming" = 'ADVANCE'`], [`"escalationRate" = 0.05`],
      [`"usageAllowancePerYear" = 1000, "usageUnit" = 'KM', "excessRateCents" = 10`], [`"cpaApplies" = true, "cpaRule" = 'CPA_FINANCIALS_UNPROVEN'`],
    ])("an approved lease's lessee, lease terms and CPA scope are frozen: %s", (set) => {
      expectRejected(`UPDATE "AssetFinanceDeal" SET ${set} WHERE "id" = '${ids.approved}'`, "lease terms and CPA scope are what was approved")
    })

    it("a loan's CPA scope: present exactly on a lease, fixed at booking", () => {
      expectRejected(replica(`UPDATE "Loan" SET "cpaApplies" = NULL WHERE "id" = '${ids.fmlLoan}'`), "Loan_cpa_scope_shape")
      expectRejected(`UPDATE "Loan" SET "cpaApplies" = TRUE, "cpaRule" = 'CPA_FINANCIALS_UNPROVEN' WHERE "id" = '${ids.fmlLoan}'`, "CPA scope is fixed at booking")
    })
  })

  describe("the lease's NON_NCA regime", () => {
    it("the lease rule implies NON_NCA; a client's NON_NCA application needs the lease rule", () => {
      expectRejected(replica(`UPDATE "LoanApplication" SET "ncaRegime" = 'NCA' WHERE "id" = '${ids.draftApp}'`), "LoanApplication_lease_rule_non_nca")
      expectRejected(replica(`UPDATE "LoanApplication" SET "ncaClassificationRule" = 'LARGE_AGREEMENT' WHERE "id" = '${ids.olApp}'`), "LoanApplication_non_nca_requires_entity")
      expectRejected(replica(`UPDATE "Loan" SET "contractType" = 'INSTALMENT_SALE', "cpaApplies" = NULL, "cpaRule" = NULL WHERE "id" = '${ids.olLoan}'`), "Loan_non_nca_requires_entity")
    })

    it("an application is inserted NON_NCA only on the lease rule, and then only with a lease deal", () => {
      const insert = (id: string, rule: string) => `INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId",
        "appliedAmount", "appliedTermDays", "ncaRegime", "ncaClassificationRule", "ncaClassifiedAt", "ncaClassifiedById", "updatedAt")
        VALUES ('${id}', '${fx.tenantId}', '${id}', '${fx.lessee}', '${fx.product}', 100000000, 1095, 'NON_NCA', '${rule}', now(), '${fx.officer}', now())`
      expectRejected(insert(`app_x_${t}`, "LARGE_AGREEMENT"), "cannot be inserted NON_NCA")
      expectRejected(insert(`app_y_${t}`, "LEASE_NOT_CREDIT_AGREEMENT"), "only a lease deal's is")
    })

    it("an application without a deal or a rule (a consumer one) is untouched by the lease rules, through classification", () => {
      const id = `app_c_${t}`
      sql(`INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays", "updatedAt")
        VALUES ('${id}', '${fx.tenantId}', '${id}', '${fx.lessee}', '${fx.product}', 100000, 90, now())`)
      sql(`UPDATE "LoanApplication" SET "ncaRegime" = 'NCA', "ncaClassificationRule" = 'NATURAL_PERSON_NCA', "ncaClassifiedAt" = now(),
        "ncaClassifiedById" = '${fx.officer}' WHERE "id" = '${id}'`)
      sql(replica(`DELETE FROM "LoanApplication" WHERE "id" = '${id}'`))
    })

    it("the lease rule is never set or dropped by an update", () => {
      const nca = `app_nca_${t}`
      sql(`INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "entityId", "productId", "appliedAmount", "appliedTermDays", "ncaRegime",
        "ncaClassificationRule", "ncaClassifiedAt", "ncaClassifiedById", "updatedAt")
        VALUES ('${nca}', '${fx.tenantId}', '${nca}', '${fx.unevidenced}', '${fx.product}', 100000000, 1095, 'NCA', 'FINANCIALS_UNPROVEN', now(), '${fx.officer}', now())`)
      expectRejected(without("LoanApplication", "LoanApplication_lease_binding", `UPDATE "LoanApplication" SET "ncaClassificationRule" = 'LEASE_NOT_CREDIT_AGREEMENT',
        "ncaClassifiedAt" = now() + INTERVAL '1 second' WHERE "id" = '${nca}'`), "keeps that rule")
      sql(replica(`DELETE FROM "LoanApplication" WHERE "id" = '${nca}'`))
      expectRejected(without("LoanApplication", "LoanApplication_guard_nca_regime_update",
        `UPDATE "LoanApplication" SET "ncaClassificationRule" = 'FINANCIALS_UNPROVEN' WHERE "id" = '${ids.draftApp}'`), "keeps that rule")
    })

    it("at commit, a lease deal's application carries the lease rule", () => {
      expectRejected(replica(`UPDATE "AssetFinanceDeal" SET "contractType" = 'INSTALMENT_SALE', "rentalTiming" = NULL, "escalationRate" = NULL,
        "earlyTerminationPenaltyRate" = NULL, "maintenanceMonthlyExclVatCents" = NULL, "maintenanceEscalationRate" = NULL, "maintenanceRiskModel" = NULL,
        "usageAllowancePerYear" = NULL, "usageUnit" = NULL, "excessRateCents" = NULL, "cpaApplies" = NULL, "cpaRule" = NULL, "cpaEvidenceIds" = ARRAY[]::TEXT[]
        WHERE "id" = '${ids.draft}'`).replace("SET LOCAL session_replication_role = replica;", ""), "only a lease deal's is")
    })

    it("a loan on a lease application is a lease loan", () => {
      expectRejected(`INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId", "entityId", "productId", "principal", "totalInterest",
        "initiationFee", "totalRepayable", "outstandingPrincipal", "startDate", "maturityDate", "interestRatePm", "interestModel", "ncaRegime",
        "contractType", "updatedAt")
        VALUES ('loan_x_${t}', '${fx.tenantId}', 'LX-${t}', '${ids.approvedApp}', '${fx.evidenced}', '${fx.product}', 100, 0, 0, 100, 100, now(),
        now() + INTERVAL '1 year', 0.01, 'REDUCING_BALANCE', 'NON_NCA', 'INSTALMENT_SALE', now())`, "only a lease loan is")
    })

    it("an override never approves the lease rule", () => {
      expectRejected(replica(`INSERT INTO "NcaRegimeOverride" ("id", "tenantId", "applicationId", "fromRegime", "toRegime", "reason", "source",
        "requestedById", "approvedEntityId", "approvedAppliedAmount", "approvedProductId", "approvedClassificationRule", "approvedClassifiedAt")
        VALUES ('ovr_x_${t}', '${fx.tenantId}', '${ids.draftApp}', 'NCA', 'NON_NCA', 'x', 'MANUAL', '${fx.officer}', '${fx.evidenced}', 1, '${fx.product}',
        'LEASE_NOT_CREDIT_AGREEMENT', now())`), "NcaRegimeOverride_approved_classification_rule_known")
    })

    it("a sole proprietor's disbursed lease application is final", () => {
      expectRejected(`UPDATE "LoanApplication" SET "status" = 'CANCELLED' WHERE "id" = '${ids.olApp}'`, "A disbursed entity application cannot change status")
    })

    it("a lease loan is never deleted or truncated", () => {
      expectRejected(without("Loan", "Loan_refuse_entity_delete", `DELETE FROM "Loan" WHERE "id" = '${ids.fmlLoan}'`), "A lease loan is never deleted")
      expectRejected(without("Loan", "Loan_refuse_entity_truncate", `TRUNCATE "Loan" CASCADE`), "A lease loan is never deleted (TRUNCATE refused)")
    })
  })

  describe("lease rentals", () => {
    it("amounts add up (CHECK)", () => {
      expectRejected(replica(`UPDATE "LeaseRental" SET "vatCents" = "vatCents" + 1 WHERE "id" = '${ids.rental}'`), "LeaseRental_amounts")
    })

    it("permits zero consideration but retains every amount CHECK", () => {
      const update = (fields: string) => `BEGIN; SET LOCAL session_replication_role = replica; UPDATE "LeaseRental" SET ${fields} WHERE "id" = '${ids.rental}'; ROLLBACK;`
      sql(update('"rentalExclVatCents" = 0, "maintenanceExclVatCents" = 0, "vatCents" = 0, "totalCents" = 0'))
      for (const fields of [
        '"rentalExclVatCents" = -1',
        '"maintenanceExclVatCents" = -1',
        '"vatCents" = -1',
        '"periodNo" = 0',
        '"vatRate" = -0.01',
        '"vatRate" = 1',
        '"totalCents" = "totalCents" + 1',
      ]) expectRejected(update(fields), "LeaseRental_amounts")
    })

    it("a rental belongs to a lease loan; an operating lease's carries no maintenance; it is written uninvoiced", () => {
      const insert = (loan: string, schedule: string, maintenance: number, invoice = "NULL") => `INSERT INTO "LeaseRental" ("id", "tenantId", "loanId",
        "scheduleId", "periodNo", "dueDate", "rentalExclVatCents", "maintenanceExclVatCents", "vatCents", "totalCents", "vatRate", "taxInvoiceId")
        VALUES ('lr_x_${randomUUID()}', '${fx.tenantId}', '${loan}', '${schedule}', 99, CURRENT_DATE, 100, ${maintenance}, 0, ${100 + maintenance}, 0.15, ${invoice})`
      const olSchedule = `(SELECT "id" FROM "RepaymentSchedule" WHERE "loanId" = '${ids.olLoan}' AND "installmentNo" = 1)`
      expectRejected(without("LeaseRental", "LeaseRental_matches_schedule", insert(ids.olLoan, olSchedule, 5).replace(`'${olSchedule}'`, olSchedule)), "carries no maintenance")
    })

    it("inside a recorded repricing a rental's maintenance still never changes; once invoiced its amounts never do", () => {
      // A ContractRate of the loan written in the same transaction: the repricing record guardLeaseRental requires.
      const recorded = `INSERT INTO "ReferenceRate" ("id", "tenantId", "basis", "effectiveDate", "rate", "requestedById")
          VALUES ('rr_m_${t}', '${fx.tenantId}', 'PRIME', CURRENT_DATE + 7, 0.1250, '${fx.adminA}');
        UPDATE "ReferenceRate" SET "status" = 'APPROVED', "decidedById" = '${fx.adminB}', "decidedAt" = now() WHERE "id" = 'rr_m_${t}';
        INSERT INTO "ContractRate" ("id", "tenantId", "loanId", "effectiveDate", "basis", "margin", "resultingRate", "newInstalmentCents")
        SELECT 'cr_m_${t}', "tenantId", "loanId", CURRENT_DATE + 7, "basis", "margin", 0.1250 + "margin", "newInstalmentCents" FROM "ContractRate"
        WHERE "loanId" = '${ids.fmlLoan}' ORDER BY "effectiveDate" DESC LIMIT 1;`
      const flagged = (set: string, setup = "") => `BEGIN; SELECT set_config('credaflow.lease_reprice', 'on', true); ${recorded} ${setup}
        UPDATE "LeaseRental" SET ${set} WHERE "id" = '${ids.rental}'; ROLLBACK;`
      expectRejected(flagged(`"maintenanceExclVatCents" = "maintenanceExclVatCents" + 1, "totalCents" = "totalCents" + 1`), "never the maintenance")
      const invoiced = `ALTER TABLE "TaxInvoice" DISABLE TRIGGER "TaxInvoice_totals_match_lines";
        INSERT INTO "TaxInvoice" ("id", "tenantId", "number", "invoiceNumber", "issueDate", "supplyDate", "loanId", "supplierName", "supplierAddress",
          "supplierVatNumber", "recipientName", "recipientAddress", "vatRate", "totalExclVatCents", "vatCents", "totalInclVatCents")
          VALUES ('inv_m_${t}', '${fx.tenantId}', 0, '', CURRENT_DATE, CURRENT_DATE, '${ids.fmlLoan}', 'L', 'A', '4000000001', 'R', 'A', 0.15, 1, 0, 1);
        SET LOCAL session_replication_role = replica; UPDATE "LeaseRental" SET "taxInvoiceId" = 'inv_m_${t}' WHERE "id" = '${ids.rental}';
        SET LOCAL session_replication_role = origin;`
      expectRejected(flagged(`"rentalExclVatCents" = "rentalExclVatCents" + 1, "totalCents" = "totalCents" + 1`, invoiced), "only a repricing changes them")
    })

    it("at commit, a rental equals its schedule row", () => {
      expectRejected(`UPDATE "RepaymentSchedule" SET "totalDue" = "totalDue" + 1, "principalDue" = "principalDue" + 1
        WHERE "id" = (SELECT "scheduleId" FROM "LeaseRental" WHERE "id" = '${ids.rental}')`, "must agree")
    })

    it("the tax invoice is set once, to an invoice of the loan for the rental's total", async () => {
      const rental = await database().leaseRental.findUniqueOrThrow({ where: { id: ids.rental } })
      const bindNew = (loan: string, total: number) => {
        const id = `inv_x_${randomUUID()}`
        return `INSERT INTO "TaxInvoice" ("id", "tenantId", "number", "invoiceNumber", "issueDate", "supplyDate",
          "loanId", "supplierName", "supplierAddress", "supplierVatNumber", "recipientName", "recipientAddress", "vatRate", "totalExclVatCents", "vatCents",
          "totalInclVatCents") VALUES ('${id}', '${fx.tenantId}', 0, '', CURRENT_DATE, CURRENT_DATE, '${loan}', 'L', 'A', '4000000001', 'R', 'A',
          0.15, ${total}, 0, ${total});
          UPDATE "LeaseRental" SET "taxInvoiceId" = '${id}' WHERE "id" = '${ids.rental}'`
      }
      expectRejected(without("TaxInvoice", "TaxInvoice_totals_match_lines", bindNew(ids.olLoan, rental.totalCents)), "of its loan, for the rental's total")
      expectRejected(without("TaxInvoice", "TaxInvoice_totals_match_lines", bindNew(ids.fmlLoan, rental.totalCents + 1)), "of its loan, for the rental's total")
    })
  })

  describe("leased vehicles: the eNaTIS owner", () => {
    it("the NATIS item needs the lender as owner; once confirmed the owner is fixed", async () => {
      const item = await database().payoutChecklistItem.findFirstOrThrow({ where: { dealId: ids.fmlDeal, item: "NATIS_TITLEHOLDER" } })
      expect(item.confirmedAt).not.toBeNull()
      expectRejected(`UPDATE "FinancedAsset" SET "natisOwner" = 'SOMEONE ELSE' WHERE "id" = '${fx.assets[0]}'`, "eNaTIS owner is attested")
      // An unconfirmed NATIS item on a contracted lease: reset it (rolled back) and try to confirm with another owner.
      expectRejected(`BEGIN; SET LOCAL session_replication_role = replica;
        UPDATE "AssetFinanceDeal" SET "status" = 'CONTRACTED' WHERE "id" = '${ids.fmlDeal}';
        UPDATE "PayoutChecklistItem" SET "confirmedAt" = NULL, "confirmedById" = NULL, "evidenceDocumentId" = NULL WHERE "id" = '${item.id}';
        UPDATE "FinancedAsset" SET "natisOwner" = 'SOMEONE ELSE' WHERE "id" = '${fx.assets[0]}';
        SET LOCAL session_replication_role = origin;
        UPDATE "PayoutChecklistItem" SET "confirmedAt" = now(), "confirmedById" = '${fx.officer}', "evidenceDocumentId" = '${item.evidenceDocumentId}'
          WHERE "id" = '${item.id}';
        ROLLBACK;`, "eNaTIS owner must be the lender")
    })
  })

  describe("booking a lease", () => {
    it("is refused without a rental per schedule row", () => {
      expectRejected(`BEGIN; SET LOCAL session_replication_role = replica;
        DELETE FROM "LeaseRental" WHERE "id" = '${ids.rental}';
        UPDATE "AssetFinanceDeal" SET "status" = 'CONTRACTED' WHERE "id" = '${ids.fmlDeal}';
        SET LOCAL session_replication_role = origin;
        ALTER TABLE "AssetFinanceDeal" DISABLE TRIGGER "AssetFinanceDeal_status_transitions";
        ALTER TABLE "AssetFinanceDeal" DISABLE TRIGGER "AssetFinanceDeal_booking_gate";
        ALTER TABLE "AssetFinanceDeal" DISABLE TRIGGER "AssetFinanceDeal_booked_by_planned_start";
        UPDATE "AssetFinanceDeal" SET "status" = 'BOOKED' WHERE "id" = '${ids.fmlDeal}';
        ROLLBACK;`, "a lease rental for every schedule row")
    })
  })
})
