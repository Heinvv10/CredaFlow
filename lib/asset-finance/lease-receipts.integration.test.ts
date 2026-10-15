/**
 * Real-Postgres proof of slice 3 C4 on every receipt path, and of the
 * invoice issuer's refusals: a bank-statement deposit and a Stitch portal
 * payment each invoice the rental they reach before its due date (a
 * back-dated deposit on its value date); a rental that cannot be invoiced
 * never refuses or rolls back the receipt, and is audited once; the issuer
 * refuses a supply date after the due date, a changed VAT rate and a missing
 * recipient address; the cron skips a tenant with asset finance off and
 * keeps going past a failing rental. Only the session is stubbed.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-receipts.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { applyBankTransaction } from "@/lib/bank-sync/apply"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { settleReceipt } from "@/app/api/portal/payment/webhook/settle-receipt"
import { runWithTenant } from "@/lib/tenant-scope"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { addMonthsClamped, dbDate, isoOfDbDate } from "./dates"
import { dueDateInstant } from "./schedule-records"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { runLeaseInvoiceBatch } from "./lease-invoice-batch"
import { issueLeaseInvoicesOnReceipt, issueLeaseRentalInvoice } from "./lease-invoices"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let entityLoan = ""
let clientLoan = ""
let spareLoan = ""
let backLoan = ""
const today = () => sastCalendarDate(new Date())
const yesterday = () => isoOfDbDate(new Date(dbDate(today()).getTime() - 86_400_000))

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })

async function book(body: Parameters<typeof leaseBody>[1], start?: string): Promise<string> {
  const dealId = await approveLease(fx, staff, leaseBody(fx, body))
  await signLease(fx, database(), setSession, dealId, start)
  return payoutAndBook(fx, database(), staff, dealId)
}

/** Test setup only (triggers off): move a booked lease's dates `months` back, so rentals have fallen due. */
async function backdate(loanId: string, months: number): Promise<void> {
  const d = database()
  await d.$transaction([
    d.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    d.$executeRawUnsafe(`UPDATE "Loan" SET "startDate" = "startDate" - INTERVAL '${months} months', "maturityDate" = "maturityDate" - INTERVAL '${months} months',
      "nextPaymentDate" = "nextPaymentDate" - INTERVAL '${months} months' WHERE "id" = $1`, loanId),
    d.$executeRawUnsafe(`UPDATE "RepaymentSchedule" SET "dueDate" = "dueDate" - INTERVAL '${months} months' WHERE "loanId" = $1`, loanId),
    d.$executeRawUnsafe(`UPDATE "LeaseRental" SET "dueDate" = ("dueDate" - INTERVAL '${months} months')::date WHERE "loanId" = $1`, loanId),
  ])
}
const rentals = (loanId: string) => database().leaseRental.findMany({ where: { loanId }, orderBy: { periodNo: "asc" }, include: { taxInvoice: true } })
const owedThrough = async (loanId: string, periodNo: number) =>
  (await rentals(loanId)).filter((r) => r.periodNo <= periodNo).reduce((sum, r) => sum + r.totalCents, 0)

suite.sequential("lease receipts on every path, and the invoice issuer's refusals (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    entityLoan = await book({ assetId: fx.assets[0], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced })
    const firstDue = addMonthsClamped(today(), 1)
    clientLoan = await book({
      assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", clientId: fx.lessee,
      rateBasis: "FIXED", rateMargin: undefined, fixedRate: "0.135", firstDueDate: firstDue,
    }, firstDue)
    spareLoan = await book({ assetId: fx.assets[2], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced })
    backLoan = await book({ assetId: fx.assets[3], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced })
    await backdate(backLoan, 1) // rental 1 falls due today, rental 2 next month
    await backdate(entityLoan, 3)
    await backdate(clientLoan, 1)
    expect((await runLeaseInvoiceBatch(database() as never, today())).ok).toBe(true)
  }, 300_000)

  afterAll(async () => {
    const tenantId = dealFixtureTenantId(t)
    await database().$transaction([
      database().$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      database().bankTransaction.deleteMany({ where: { tenantId } }),
      database().bankStatementImport.deleteMany({ where: { tenantId } }),
      database().stitchPaymentRequest.deleteMany({ where: { loan: { tenantId } } }),
    ]).catch(() => undefined)
    await cleanupLeaseRows(database(), tenantId).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId })
    await db?.$disconnect()
  }, 60_000)

  it("a back-dated receipt captured after a later one: the rental is supplied the day the cash reached it, not the receipt's date", async () => {
    const [first, second] = await rentals(backLoan)
    const receipt = (amount: number, receivedAt: Date, reference: string) =>
      applyManualReceipt(database() as unknown as PaymentDb, { loanId: backLoan, tenantId: fx.tenantId, amount, capturedById: fx.officer, reference, receivedAt })
    await receipt(first.totalCents, new Date(), "SYNTHETIC-BACK-A") // today: settles rental 1 exactly
    await receipt(500, dueDateInstant(yesterday()), "SYNTHETIC-BACK-B") // back-dated R5.00: the cash passes rental 1 only today
    const invoiced = (await rentals(backLoan)).find((r) => r.id === second.id)
    expect(invoiced?.taxInvoice && isoOfDbDate(invoiced.taxInvoice.supplyDate)).toBe(today())
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "LEASE_INVOICE_REFUSED", entityId: second.id } })).toBe(0)
  }, 60_000)

  it("a rental already due that no cash reached (a waiver paid it) is invoiced on its due date by the receipt hook", async () => {
    // Test setup (triggers off): rental 3 fell due yesterday, its row paid by a waiver, and the cron has not run.
    const third = (await rentals(backLoan))[2]
    await database().$transaction([
      database().$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      database().$executeRawUnsafe(`UPDATE "LeaseRental" SET "dueDate" = $2::date WHERE "id" = $1`, third.id, yesterday()),
      database().$executeRawUnsafe(`UPDATE "RepaymentSchedule" SET "dueDate" = $2::timestamp, "totalPaid" = 1 WHERE "id" = $1`, third.scheduleId, dueDateInstant(yesterday())),
    ])
    await database().$transaction((tx) => issueLeaseInvoicesOnReceipt(tx as never, { tenantId: fx.tenantId, loanId: backLoan, contractType: "OPERATING_LEASE", today: today(), createdById: null }))
    const invoiced = (await rentals(backLoan)).find((r) => r.id === third.id)
    expect(invoiced?.taxInvoice && isoOfDbDate(invoiced.taxInvoice.supplyDate)).toBe(yesterday())
  }, 60_000)

  it("a back-dated bank deposit invoices the rental it reaches before its due date, on the deposit's value date", async () => {
    const amount = (await owedThrough(entityLoan, 3)) + 100 // rentals 1–3 are due; R1.00 reaches rental 4
    const imp = await database().bankStatementImport.create({
      data: { tenantId: fx.tenantId, source: "ABSA_ONLINE", accountRef: "****1234", format: "CSV", fileHash: randomUUID(), rawFilePath: "x" },
    })
    const txn = await database().bankTransaction.create({
      data: {
        tenantId: fx.tenantId, importId: imp.id, postedDate: dbDate(today()), valueDate: dbDate(yesterday()),
        amountCents: amount, direction: "CREDIT", dedupHash: randomUUID(), matchStatus: "PROPOSED",
      },
    })
    await applyBankTransaction({ txnId: txn.id, loanId: entityLoan, tenantId: fx.tenantId, userEmail: "bank@lease-it.test" })
    const fourth = (await rentals(entityLoan))[3]
    expect(isoOfDbDate(fourth.dueDate) > today()).toBe(true)
    expect(fourth.taxInvoice && isoOfDbDate(fourth.taxInvoice.supplyDate)).toBe(yesterday())
    expect((await rentals(entityLoan))[4].taxInvoiceId).toBeNull()
  }, 60_000)

  it("a Stitch portal payment invoices the rental it reaches before its due date, on the day it is received", async () => {
    const amount = (await owedThrough(clientLoan, 1)) + 100 // rental 1 is due today; R1.00 reaches rental 2
    const ref = `STITCH-${randomUUID()}`
    const request = await database().stitchPaymentRequest.create({
      data: { stitchId: ref, loanId: clientLoan, clientId: fx.lessee, amount, redirectUrl: "https://x.invalid", stitchUrl: "https://x.invalid", externalReference: ref },
      include: { loan: { select: { tenantId: true } } },
    })
    await runWithTenant(fx.tenantId, () => settleReceipt(request, ref, fx.tenantId))
    const second = (await rentals(clientLoan))[1]
    expect(second.taxInvoice && isoOfDbDate(second.taxInvoice.supplyDate)).toBe(today())
  }, 60_000)

  it("a rental that cannot be invoiced never refuses the receipt, and is audited once", async () => {
    // Tamper (triggers off): rental 1's booked VAT rate no longer matches the rate in force.
    const first = (await rentals(spareLoan))[0]
    await database().$transaction([
      database().$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      database().$executeRawUnsafe(`UPDATE "LeaseRental" SET "vatRate" = 0.1400 WHERE "id" = $1`, first.id),
    ])
    for (const reference of ["SYNTHETIC-1", "SYNTHETIC-2"]) {
      const result = await applyManualReceipt(database() as unknown as PaymentDb, { loanId: spareLoan, tenantId: fx.tenantId, amount: 100, capturedById: fx.officer, reference })
      expect(result.payment.amount).toBe(100)
    }
    expect((await rentals(spareLoan))[0].taxInvoiceId).toBeNull()
    const audits = await database().auditLog.findMany({ where: { tenantId: fx.tenantId, action: "LEASE_INVOICE_REFUSED", entityId: first.id } })
    expect(audits).toHaveLength(1)
    expect(audits[0].newValue).toMatchObject({ reason: "vat_rate_changed", source: "receipt" })
  }, 60_000)

  it("an invoice that throws after it is written is rolled back alone: the receipt stands", async () => {
    // A test-only deferred check that refuses binding rental 3's invoice: the invoice passes every check in code and
    // fails only at a deferred constraint, which the savepoint must force and roll back alone (dropped below).
    const [, second, third] = await rentals(clientLoan)
    await database().$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "it_refuse_rental_invoice"() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW."id" = '${third.id}' AND NEW."taxInvoiceId" IS NOT NULL THEN RAISE EXCEPTION 'it: deferred refusal'; END IF; RETURN NULL; END $f$`)
    await database().$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER "it_refuse_rental_invoice" AFTER UPDATE ON "LeaseRental"
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "it_refuse_rental_invoice"()`)
    try {
      const paidOnSecond = (await database().repaymentSchedule.findUniqueOrThrow({ where: { id: second.scheduleId } })).totalPaid
      const amount = second.totalCents - paidOnSecond + 100 // settles rental 2; R1.00 reaches rental 3
      const result = await applyManualReceipt(database() as unknown as PaymentDb, { loanId: clientLoan, tenantId: fx.tenantId, amount, capturedById: fx.officer, reference: "SYNTHETIC-3" })
      expect(await database().payment.count({ where: { id: result.payment.id } })).toBe(1)
      expect((await rentals(clientLoan))[2].taxInvoiceId).toBeNull()
      expect(await database().taxInvoice.count({ where: { loanId: clientLoan } })).toBe(2) // rentals 1 and 2 only
      const audit = await database().auditLog.findFirstOrThrow({ where: { tenantId: fx.tenantId, action: "LEASE_INVOICE_REFUSED", entityId: third.id } })
      expect(audit.newValue).toMatchObject({ reason: "invoice_error", source: "receipt" })
    } finally {
      await database().$executeRawUnsafe(`DROP TRIGGER IF EXISTS "it_refuse_rental_invoice" ON "LeaseRental"`)
      await database().$executeRawUnsafe(`DROP FUNCTION IF EXISTS "it_refuse_rental_invoice"()`)
    }
  }, 60_000)

  it("the issuer refuses a supply date after the due date, and a lessee with no address", async () => {
    const r = (await rentals(spareLoan))[2]
    const issue = (supplyDate: string) => database().$transaction((tx) => issueLeaseRentalInvoice(tx as never, {
      tenantId: fx.tenantId, rentalId: r.id, supplyDate, today: today(), createdById: null, source: "staff",
    }))
    expect(await issue(addMonthsClamped(isoOfDbDate(r.dueDate), 1))).toMatchObject({ kind: "refused", reason: "supply_date" })
    const entity = await database().businessEntity.findUniqueOrThrow({ where: { id: fx.evidenced } })
    await database().$transaction([
      database().$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      database().$executeRawUnsafe(`UPDATE "BusinessEntity" SET "addressLine1" = NULL WHERE "id" = $1`, fx.evidenced),
    ])
    try {
      expect(await issue(today())).toMatchObject({ kind: "refused", reason: "recipient" })
    } finally {
      await database().$transaction([
        database().$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
        database().$executeRawUnsafe(`UPDATE "BusinessEntity" SET "addressLine1" = $2 WHERE "id" = $1`, fx.evidenced, entity.addressLine1),
      ])
    }
  }, 60_000)

  it("the cron leaves a tenant with asset finance off alone, and keeps going past a failing rental", async () => {
    await backdate(spareLoan, 2) // rentals 1–2 due; rental 1 refused (VAT tampered), rental 2 invoiceable
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { featureAssetFinance: false } })
    try {
      const off = await runLeaseInvoiceBatch(database() as never, today())
      expect(off.issued).toBe(0)
      expect((await rentals(spareLoan))[1].taxInvoiceId).toBeNull()
    } finally {
      await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { featureAssetFinance: true } })
    }
    const on = await runLeaseInvoiceBatch(database() as never, today())
    expect(on.refused.vat_rate_changed).toBe(1)
    expect((await rentals(spareLoan))[1].taxInvoiceId).not.toBeNull()
  }, 60_000)
})
