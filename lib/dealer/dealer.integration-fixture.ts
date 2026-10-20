/**
 * Real-Postgres fixture for the RUN_ASSET_FINANCE_DEALER_IT suites: the deal
 * fixture's tenant (no templates), marked a demo lender with the dealer portal
 * on, two dealers (A a VAT vendor, B not), their users, and an APPROVED
 * supplier bank account for the payouts the booking helper writes. Every value
 * is synthetic. Statements run through psql (af-sql.integration-fixture.ts) so
 * the suites assert on the database's own constraint names and RAISE text.
 * Not a test file.
 */
import type { PrismaClient } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { sql } from "@/lib/asset-finance/af-sql.integration-fixture"
import { cleanupDealFixture, createDealFixture, dealFixtureTenantId, type DealFixture } from "@/lib/asset-finance/deal.integration-fixture"

export interface DealerFixture extends DealFixture {
  /** A VAT vendor (vatNumber set). */
  dealerA: string
  /** Not a VAT vendor. */
  dealerB: string
  /** DEALER_ADMIN of A, created by staff. */
  adminUserA: string
  /** DEALER_SALES of A, created by adminUserA. */
  salesUserA: string
  /** DEALER_ADMIN of B. */
  userB: string
  /** The supplier's APPROVED bank account (for booking payouts). */
  supplierAccount: string
}

export const DEALER_FIXTURE_VAT_NUMBER = "4000000099"

/** SQL literal: NULL for null/undefined, a number as is, anything else quoted. */
export function lit(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "NULL"
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return `'${value.replaceAll("'", "''")}'`
}

/** A fresh id with a recognisable prefix. */
export const newId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`

/** Today's calendar date in Johannesburg, as the triggers compute it. */
export const TODAY_SQL = `(now() AT TIME ZONE 'Africa/Johannesburg')::date`

export function insertDealer(tenantId: string, createdById: string, over: { name: string; vatNumber?: string | null; supplierId?: string | null }): string {
  const id = newId("dlr")
  sql(`INSERT INTO "Dealer" ("id", "tenantId", "name", "kind", "vatNumber", "vatVendor", "supplierId", "contactEmail", "createdById", "updatedAt")
    VALUES (${lit(id)}, ${lit(tenantId)}, ${lit(over.name)}, 'DEALER', ${lit(over.vatNumber ?? null)}, ${over.vatNumber ? "true" : "false"},
      ${lit(over.supplierId ?? null)}, 'sales@dealer.invalid', ${lit(createdById)}, CURRENT_TIMESTAMP)`)
  return id
}

export function insertDealerUser(
  tenantId: string, dealerId: string,
  over: { role?: "DEALER_ADMIN" | "DEALER_SALES"; byUser?: string; byDealerUser?: string },
): string {
  const id = newId("dlu")
  sql(`INSERT INTO "DealerUser" ("id", "tenantId", "dealerId", "email", "name", "role", "createdByUserId", "createdByDealerUserId", "updatedAt")
    VALUES (${lit(id)}, ${lit(tenantId)}, ${lit(dealerId)}, ${lit(`${id}@dealer.invalid`)}, 'TEST Dealer User', '${over.role ?? "DEALER_SALES"}',
      ${lit(over.byUser ?? null)}, ${lit(over.byDealerUser ?? null)}, CURRENT_TIMESTAMP)`)
  return id
}

/** A commission rate row (dealerId null = the tenant default). */
export function insertRate(fx: DealerFixture, over: { dealerId: string | null; from: string; bps: number; flatCents: number }): string {
  const id = newId("dcr")
  sql(`INSERT INTO "DealerCommissionRate" ("id", "tenantId", "dealerId", "effectiveFrom", "bps", "flatCents", "createdById")
    VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(over.dealerId)}, ${over.from}, ${over.bps}, ${over.flatCents}, ${lit(fx.adminA)})`)
  return id
}

/** A dealer bank account requested by `requester`, PENDING. */
export function requestDealerAccount(fx: DealerFixture, dealerId: string, requester = fx.officer, accountNumber = "0000000002"): string {
  const id = newId("dba")
  sql(`INSERT INTO "DealerBankAccount" ("id", "tenantId", "dealerId", "bankName", "branchCode", "accountNumber", "accountHolder", "requestedById")
    VALUES (${lit(id)}, ${lit(fx.tenantId)}, ${lit(dealerId)}, 'TEST Bank', '000001', ${lit(accountNumber)}, 'TEST Dealer (Pty) Ltd', ${lit(requester)})`)
  return id
}

export const decideDealerAccount = (accountId: string, decider: string, status: "APPROVED" | "REJECTED" = "APPROVED") =>
  `UPDATE "DealerBankAccount" SET "status" = '${status}', "decidedById" = ${lit(decider)}, "decidedAt" = CURRENT_TIMESTAMP,
     "avsResult" = '{"manual":"bank letter on file"}' WHERE "id" = ${lit(accountId)}`

/** A dealer account requested by the officer and approved by adminB. */
export function approvedDealerAccount(fx: DealerFixture, dealerId: string, accountNumber?: string): string {
  const id = requestDealerAccount(fx, dealerId, fx.officer, accountNumber)
  sql(decideDealerAccount(id, fx.adminB))
  return id
}

export async function createDealerFixture(db: PrismaClient, t: string, opts: { clawbackMonths?: number } = {}): Promise<DealerFixture> {
  const base = await createDealFixture(db, t, { templates: false })
  sql(`UPDATE "TenantConfig" SET "isDemoLender" = true, "featureDealerPortal" = true,
    "dealerCommissionClawbackMonths" = ${opts.clawbackMonths ?? 12} WHERE "tenantId" = ${lit(base.tenantId)}`)
  const dealerA = insertDealer(base.tenantId, base.adminA, { name: `TEST Motors ${t}`, vatNumber: DEALER_FIXTURE_VAT_NUMBER })
  const dealerB = insertDealer(base.tenantId, base.adminA, { name: `TEST Brokers ${t}` })
  const adminUserA = insertDealerUser(base.tenantId, dealerA, { role: "DEALER_ADMIN", byUser: base.adminA })
  const salesUserA = insertDealerUser(base.tenantId, dealerA, { role: "DEALER_SALES", byDealerUser: adminUserA })
  const userB = insertDealerUser(base.tenantId, dealerB, { role: "DEALER_ADMIN", byUser: base.adminA })
  const supplierAccount = newId("sba")
  sql(`INSERT INTO "SupplierBankAccount" ("id", "tenantId", "supplierId", "bankName", "branchCode", "accountNumber", "accountHolder", "requestedById")
      VALUES (${lit(supplierAccount)}, ${lit(base.tenantId)}, ${lit(base.supplier)}, 'TEST Bank', '000001', '0000000001', 'TEST Plant Sales', ${lit(base.officer)});
    UPDATE "SupplierBankAccount" SET "status" = 'APPROVED', "decidedById" = ${lit(base.adminB)}, "decidedAt" = CURRENT_TIMESTAMP,
      "avsResult" = '{"manual":"bank letter on file"}' WHERE "id" = ${lit(supplierAccount)}`)
  return { ...base, dealerA, dealerB, adminUserA, salesUserA, userB, supplierAccount }
}

/**
 * The dealer rows go first, with triggers (and so the guards and foreign keys)
 * off for the one transaction; then the deal fixture's own cleanup, which
 * removes the deals, loans and borrowers that referenced them.
 */
export async function cleanupDealerFixture(db: PrismaClient, t: string): Promise<void> {
  const tenantId = lit(dealFixtureTenantId(t))
  const tables = [
    "DealerPayableRunLine", "DealerPayableRun", "DealerCommissionLine", "DealerConsentAttestation", "DealerDocumentRequest",
    "DealerBankAccount", "EntityDocument", "PayoutChecklistItem", "DisbursementReversal",
  ]
  sql(`BEGIN;
    SET LOCAL session_replication_role = replica;
    ${tables.map((table) => `DELETE FROM "${table}" WHERE "tenantId" = ${tenantId};`).join("\n")}
    DELETE FROM "DealerCommissionRate" WHERE "tenantId" = ${tenantId};
    DELETE FROM "DealerUser" WHERE "tenantId" = ${tenantId};
    DELETE FROM "Dealer" WHERE "tenantId" = ${tenantId};
    COMMIT;`)
  await cleanupDealFixture(db, { tenantId: dealFixtureTenantId(t) })
}

/** Runs a suite's cleanup without hiding a failure of the suite's own setup. */
export async function cleanupDealerFixtureIfCreated(db: PrismaClient | null, t: string): Promise<void> {
  if (!db) return
  try {
    await cleanupDealerFixture(db, t)
  } finally {
    await db.$disconnect()
  }
}
