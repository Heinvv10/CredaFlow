/**
 * Each clause of the slice 3 C8 termination rules, the lease charge link and
 * the tenant's lease settings refuses its attack, and is what refuses it: the
 * same attack goes through with that one clause (or rule) taken out, inside a
 * rolled-back transaction. A quote is dated today and valid for the tenant's
 * days at most; accepted only while valid, then final; an accepted quote with
 * something to invoice carries its invoice and charge row; a rental is
 * cancelled only by a termination accepted with it, ending before it; a lease
 * charge's tax invoice is its own loan's, not a rental's, not shared, and a
 * termination's is the quoted amount; a charge row is linked once; the lease
 * settings stay in range.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-servicing-rules-quote.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { appendLeaseCharge } from "./lease-charges"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { backdateLease, ruleAdmits, ruleRefuses } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { runLeaseInvoiceBatch } from "./lease-invoice-batch"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const loans = { running: "", other: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
const today = () => sastCalendarDate(new Date())
const day = (offset: number) => fromDayNumber(toDayNumber(today()) + offset)
const Q = "guardLeaseTerminationQuote"
const LINK = "checkLeaseChargeLink"

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const refuses = (rule: Parameters<typeof ruleRefuses>[1], message: RegExp, attack: (tx: Tx) => Promise<unknown>) => ruleRefuses(database(), rule, message, attack)
const without = (fn: string, clause: string, replacement = "") => ({ fn, replace: [clause, replacement] as const })

async function book(assetId: string): Promise<string> {
  const dealId = await approveLease(fx, staff, leaseBody(fx, {
    assetId, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced, preset: { kind: "MONTHLY", periods: 36 }, balloonCents: 100_000_000,
  }))
  await signLease(fx, database(), setSession, dealId)
  const loanId = await payoutAndBook(fx, database(), staff, dealId)
  await backdateLease(database(), loanId, 2)
  return loanId
}

/** A quote of the running lease: R1.00 PV + 10c penalty, 17c VAT (half-up per line), no arrears. */
const quote = (tx: Tx, data: Record<string, unknown> = {}) => tx.leaseTerminationQuote.create({
  data: {
    tenantId: fx.tenantId, loanId: loans.running, quotedOn: dbDate(today()), terminationDate: dbDate(today()), validUntil: dbDate(today()),
    cpaCancellation: false, remainingRentals: 1, pvCents: 100, penaltyCents: 10, arrearsCents: 0, invoiceExclVatCents: 110, invoiceVatCents: 17,
    totalCents: 127, basis: "Synthetic basis for a test", ...data,
  },
  select: { id: true },
})
/** Nothing to invoice (arrears only): accepted without an invoice or a charge row. */
const unbilled = { pvCents: 0, penaltyCents: 0, invoiceExclVatCents: 0, invoiceVatCents: 0, arrearsCents: 127 }
const accept = (tx: Tx, id: string, data: Record<string, unknown> = {}) =>
  tx.leaseTerminationQuote.update({ where: { id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: fx.adminA, ...data } })
const invoice = (tx: Tx, loanId: string, units: number[] = [100, 10]) => issueTaxInvoice(tx as never, {
  tenantId: fx.tenantId, loanId, issueDate: today(), supplyDate: today(), createdById: fx.adminA,
  recipient: { name: "TEST Lessee (Pty) Ltd", address: "9 Synthetic Yard, Johannesburg, 2001", vatNumber: null },
  lines: units.map((unitExclVatCents, i) => ({ description: `Synthetic charge ${i + 1}`, quantity: 1, unitExclVatCents })),
})
const chargeRow = (tx: Tx, loanId: string, amountCents: number) =>
  appendLeaseCharge(tx as never, { tenantId: fx.tenantId, loanId, amountCents, dueDate: today(), actorUserId: fx.adminA, why: "test" })
/** A quote accepted the real way: its invoice for the quoted amount and its charge row; deferred checks run, then deferred again. */
async function billedAcceptance(tx: Tx) {
  const { id } = await quote(tx)
  const issued = await invoice(tx, loans.running)
  const scheduleId = await chargeRow(tx, loans.running, issued.totalInclVatCents)
  await accept(tx, id, { taxInvoiceId: issued.id, scheduleId })
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED")
  return { quoteId: id, invoiceId: issued.id, total: issued.totalInclVatCents, scheduleId }
}
/** An expiry return of the running lease, written straight to INVOICED with `link` (test setup inside the transaction, triggers off). */
async function invoicedEnd(tx: Tx, link: { taxInvoiceId: string; scheduleId?: string | null }) {
  const id = randomUUID()
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
  await tx.$executeRawUnsafe(`INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "status", "updatedAt", "inspectedOn", "inspectedById", "inspectionCondition")
    VALUES ($1, $2, $3, 'EXPIRY', 'RETURN', 'INVOICED', now(), $4::date, $5, 'Synthetic: fine')`, id, fx.tenantId, loans.running, today(), fx.officer)
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin")
  // The link is written with the triggers on: the deferred charge-link check is queued for it.
  await tx.leaseEndOfTerm.update({ where: { id }, data: { taxInvoiceId: link.taxInvoiceId, scheduleId: link.scheduleId ?? null } })
}
const CHARGE = /A lease charge's tax invoice is its own loan's, not a rental's, not shared/

suite.sequential("lease servicing rules: termination quotes, rental cancellation, charge links, settings (each clause removed → the attack goes through)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    loans.running = await book(fx.assets[1])
    loans.other = await book(fx.assets[2])
    expect((await runLeaseInvoiceBatch(database() as never, today())).ok).toBe(true)
  }, 600_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("a quote is dated today and valid for the tenant's days at most (10: admitted; 11: refused)", async () => {
    const DATED = /dated today and valid for the tenant's days at most/
    await ruleAdmits(database(), (tx) => quote(tx, { validUntil: dbDate(day(10)) }))
    await refuses(without(Q, `IF NEW."quotedOn" <> today OR`, "IF"), DATED, (tx) => quote(tx, { quotedOn: dbDate(day(-1)), terminationDate: dbDate(day(-1)), validUntil: dbDate(day(-1)) }))
    await refuses(without(Q, ` OR NEW."validUntil" > today + COALESCE(`, " OR FALSE AND 0 < COALESCE("), DATED, (tx) => quote(tx, { validUntil: dbDate(day(11)) }))
  })

  it("a quote is accepted while valid (until its last day: admitted; the day after: refused)", async () => {
    await ruleAdmits(database(), async (tx) => accept(tx, (await quote(tx, unbilled)).id))
    await refuses(without(Q, `AND today > NEW."validUntil"`, "AND FALSE"), /The quote expired on/, async (tx) => {
      const { id } = await quote(tx, unbilled)
      // Test setup: the quote was given two days ago, valid until yesterday.
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      await tx.$executeRawUnsafe(`UPDATE "LeaseTerminationQuote" SET "quotedOn" = $2::date, "terminationDate" = $2::date, "validUntil" = $3::date WHERE "id" = $1`, id, day(-2), day(-1))
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin")
      await accept(tx, id)
    })
  })

  it("an accepted quote is final; with something to invoice it carries its invoice and charge row", async () => {
    await refuses(without(Q, `IF OLD."status" = 'ACCEPTED' THEN`, "IF FALSE THEN"), /accepted termination quote is final/, async (tx) => {
      const { id } = await quote(tx, unbilled)
      await accept(tx, id)
      await tx.leaseTerminationQuote.update({ where: { id }, data: { acceptedById: fx.adminB } })
    })
    await refuses({ table: "LeaseTerminationQuote", constraint: "LeaseTerminationQuote_accepted_billed" }, /LeaseTerminationQuote_accepted_billed/,
      async (tx) => accept(tx, (await quote(tx)).id))
  })

  it("a rental is cancelled only by a termination of its loan accepted in the same transaction, ending before it", async () => {
    const DEFERRED = /cancelled only by a termination accepted with it/
    const cancel = async (tx: Tx, periodNo = 10) => {
      const rental = await tx.leaseRental.findFirstOrThrow({ where: { loanId: loans.running, periodNo } })
      await tx.$executeRawUnsafe("SELECT set_config('credaflow.lease_terminate', 'on', true)")
      await tx.leaseRental.update({ where: { id: rental.id }, data: { cancelledAt: new Date() } })
      await tx.repaymentSchedule.update({ where: { id: rental.scheduleId }, data: { principalDue: 0, totalDue: 0 } })
      return rental
    }
    // A QUOTED, valid quote ending before the rental passes the immediate guard; nothing is accepted.
    await refuses({ table: "LeaseRental", trigger: "LeaseRental_cancelled_by_acceptance" }, DEFERRED, async (tx) => { await quote(tx, unbilled); await cancel(tx) })
    // Accepted in the same transaction, but ending after the rental.
    await refuses(without("checkLeaseRentalCancelled", ` AND NEW."dueDate" > q."terminationDate"`), DEFERRED, async (tx) => {
      await quote(tx, unbilled)
      // The next rental (within the 60-day termination window), and a termination the day after it.
      const rental = await tx.leaseRental.findFirstOrThrow({ where: { loanId: loans.running, dueDate: { gt: dbDate(today()) } }, orderBy: { periodNo: "asc" } })
      const late = fromDayNumber(toDayNumber(sastCalendarDate(rental.dueDate)) + 1)
      await accept(tx, (await quote(tx, { ...unbilled, terminationDate: dbDate(late), validUntil: dbDate(today()) })).id)
      await cancel(tx, rental.periodNo)
    })
  })

  it("a termination accepted in an earlier transaction does not license a later cancellation (the quote must be accepted with it)", async () => {
    // Committed: an accepted (unbilled) termination of the other lease, ending today.
    await database().$transaction(async (tx) => accept(tx, (await quote(tx, { ...unbilled, loanId: loans.other })).id))
    await refuses(without("checkLeaseRentalCancelled", ` AND q."xmin" = pg_current_xact_id()::xid`), /cancelled only by a termination accepted with it/, async (tx) => {
      await quote(tx, { ...unbilled, loanId: loans.other }) // a valid QUOTED quote passes the immediate guard
      const rental = await tx.leaseRental.findFirstOrThrow({ where: { loanId: loans.other, periodNo: 10 } })
      await tx.$executeRawUnsafe("SELECT set_config('credaflow.lease_terminate', 'on', true)")
      await tx.leaseRental.update({ where: { id: rental.id }, data: { cancelledAt: new Date() } })
      await tx.repaymentSchedule.update({ where: { id: rental.scheduleId }, data: { principalDue: 0, totalDue: 0 } })
    })
  })

  it("a lease charge's tax invoice is its own loan's, not a rental's, and a termination's is the quoted amount", async () => {
    await refuses(without(LINK, ` AND i."loanId" = NEW."loanId"`), CHARGE, async (tx) => invoicedEnd(tx, { taxInvoiceId: (await invoice(tx, loans.other)).id }))
    await refuses(without(LINK, `OR EXISTS (SELECT 1 FROM "LeaseRental" r WHERE r."taxInvoiceId" = NEW."taxInvoiceId" AND r."tenantId" = NEW."tenantId")`), CHARGE, async (tx) => {
      const rental = await tx.leaseRental.findFirstOrThrow({ where: { loanId: loans.running, periodNo: 1 } })
      await invoicedEnd(tx, { taxInvoiceId: rental.taxInvoiceId ?? "" })
    })
    await ruleAdmits(database(), (tx) => billedAcceptance(tx))
    await refuses(without(LINK, `TG_TABLE_NAME <> 'LeaseTerminationQuote'`, "TRUE"), CHARGE, async (tx) => {
      const issued = await invoice(tx, loans.running, [1_000])
      await accept(tx, (await quote(tx)).id, { taxInvoiceId: issued.id, scheduleId: await chargeRow(tx, loans.running, issued.totalInclVatCents) })
    })
  })

  it("a charge's invoice is not shared, and a charge row is linked by one end of term or termination", async () => {
    await refuses(without(LINK, `OR EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."taxInvoiceId" = NEW."taxInvoiceId" AND q."tenantId" = NEW."tenantId" AND q."id" <> NEW."id")`),
      CHARGE, async (tx) => invoicedEnd(tx, { taxInvoiceId: (await billedAcceptance(tx)).invoiceId }))
    await refuses(without("leaseChargeRowMismatch", `) > 1;`, ") > 99;"), /lease charge row is a schedule row of its own loan/, async (tx) => {
      const accepted = await billedAcceptance(tx)
      await invoicedEnd(tx, { taxInvoiceId: (await invoice(tx, loans.running)).id, scheduleId: accepted.scheduleId }) // same total, another invoice
    })
  })

  it("a termination is quoted for a date within 60 days; a valuation is never dated in the future, never edited", async () => {
    await ruleAdmits(database(), (tx) => quote(tx, { terminationDate: dbDate(day(60)) }))
    await refuses({ table: "LeaseTerminationQuote", constraint: "LeaseTerminationQuote_termination_window" }, /LeaseTerminationQuote_termination_window/,
      (tx) => quote(tx, { terminationDate: dbDate(day(61)) }))
    const valuation = (tx: Tx, valuedOn: string) => tx.assetValuation.create({
      data: { tenantId: fx.tenantId, assetId: fx.assets[1], valuedOn: dbDate(valuedOn), source: "ASSESSOR", valuerName: "TEST Assessors", amountCents: 1_000, createdById: fx.adminB },
    })
    const VALUATION = { table: "AssetValuation", trigger: "AssetValuation_guard" }
    await refuses(VALUATION, /not dated in the future/, (tx) => valuation(tx, day(1)))
    await refuses(VALUATION, /never edited/, async (tx) => tx.assetValuation.update({ where: { id: (await valuation(tx, today())).id }, data: { amountCents: 9_999 } }))
  })

  it("the tenant's lease settings stay in range (the bounds admitted, one past them refused)", async () => {
    const settings = (data: { [K in "maintenanceClaimDualApprovalCents" | "leasePurchaseValuationMaxAgeDays" | "leaseTerminationQuoteValidDays"]?: number }) => (tx: Tx) => tx.tenantConfig.update({ where: { tenantId: fx.tenantId }, data })
    const rule = { table: "TenantConfig", constraint: "TenantConfig_lease_settings" }
    for (const ok of [
      { maintenanceClaimDualApprovalCents: 1 }, { maintenanceClaimDualApprovalCents: 1_000_000_000 }, { leasePurchaseValuationMaxAgeDays: 1 },
      { leasePurchaseValuationMaxAgeDays: 180 }, { leaseTerminationQuoteValidDays: 1 }, { leaseTerminationQuoteValidDays: 60 },
    ]) await ruleAdmits(database(), settings(ok))
    for (const bad of [
      { maintenanceClaimDualApprovalCents: 0 }, { maintenanceClaimDualApprovalCents: 1_000_000_001 }, { leasePurchaseValuationMaxAgeDays: 0 },
      { leasePurchaseValuationMaxAgeDays: 181 }, { leaseTerminationQuoteValidDays: 0 }, { leaseTerminationQuoteValidDays: 61 },
    ]) await refuses(rule, /TenantConfig_lease_settings/, settings(bad))
  })
})
