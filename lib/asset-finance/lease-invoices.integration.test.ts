/**
 * Real-Postgres proof of slice 3 C4 (and the lease repricing of C3): the daily
 * cron invoices each rental that has fallen due exactly once, rental and
 * maintenance lines, supply date = due date; two issuers racing on one rental
 * write one invoice; a receipt that reaches a rental before its due date
 * invoices it at receipt; the lessee and only the lessee reads the invoices in
 * the portal; a reference-rate move reprices the uninvoiced rentals and keeps
 * every LeaseRental equal to its schedule row. Only the session is stubbed.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-invoices.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { addMonthsClamped, dbDate, isoOfDbDate } from "./dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { runLeaseInvoiceBatch } from "./lease-invoice-batch"
import { issueLeaseRentalInvoice } from "./lease-invoices"
import { repriceLoanForReference } from "./reprice-loan"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { GET as portalInvoiceRoute } from "@/app/api/portal/asset-finance/leases/[loanId]/tax-invoices/[invoiceId]/route"

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let fmlLoan = ""
let olLoan = ""
let repriceLoan = ""
const today = () => sastCalendarDate(new Date())

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const asClient = (clientId: string) => setSession({ id: clientId, email: `${clientId}@lease-it.test`, role: "CLIENT", tenantId: fx.tenantId })
const portalInvoice = (loanId: string, invoiceId: string) =>
  portalInvoiceRoute(new NextRequest(`http://${fx.host}/api/portal/asset-finance/leases/${loanId}/tax-invoices/${invoiceId}`, { headers: { host: fx.host } }),
    { params: Promise.resolve({ loanId, invoiceId }) })

async function book(body: Parameters<typeof leaseBody>[1], start?: string): Promise<string> {
  const dealId = await approveLease(fx, staff, leaseBody(fx, body))
  await signLease(fx, database(), setSession, dealId, start)
  return payoutAndBook(fx, database(), staff, dealId)
}

/** Test setup only: move a booked lease's dates `months` back, so rentals have fallen due. */
async function backdate(loanId: string, months: number): Promise<void> {
  await database().$transaction([
    database().$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    database().$executeRawUnsafe(`UPDATE "Loan" SET "startDate" = "startDate" - INTERVAL '${months} months', "maturityDate" = "maturityDate" - INTERVAL '${months} months',
      "nextPaymentDate" = "nextPaymentDate" - INTERVAL '${months} months' WHERE "id" = $1`, loanId),
    database().$executeRawUnsafe(`UPDATE "RepaymentSchedule" SET "dueDate" = "dueDate" - INTERVAL '${months} months' WHERE "loanId" = $1`, loanId),
    database().$executeRawUnsafe(`UPDATE "LeaseRental" SET "dueDate" = ("dueDate" - INTERVAL '${months} months')::date WHERE "loanId" = $1`, loanId),
  ])
}

suite.sequential("lease rentals: one tax invoice per rental (real Postgres)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    fmlLoan = await book({ assetId: fx.assets[0], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced })
    const firstDue = addMonthsClamped(today(), 1)
    olLoan = await book({
      assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", clientId: fx.lessee,
      rateBasis: "FIXED", rateMargin: undefined, fixedRate: "0.135", firstDueDate: firstDue,
    }, firstDue)
    repriceLoan = await book({ assetId: fx.assets[2], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced, periods: 24 })
  }, 300_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await database().payment.deleteMany({ where: { tenantId: dealFixtureTenantId(t) } }).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("two issuers racing on one due rental write exactly one invoice", async () => {
    await backdate(fmlLoan, 3) // rentals 1–3 have fallen due
    const rental = await database().leaseRental.findFirstOrThrow({ where: { loanId: fmlLoan, periodNo: 1 } })
    const issue = () => database().$transaction((tx) => issueLeaseRentalInvoice(tx as never, {
      tenantId: fx.tenantId, rentalId: rental.id, supplyDate: isoOfDbDate(rental.dueDate), today: today(), createdById: null, source: "cron",
    }))
    const results = await Promise.all([issue(), issue()])
    expect(results.map((r) => r.kind).sort()).toEqual(["already_invoiced", "issued"])
    expect(await database().taxInvoice.count({ where: { loanId: fmlLoan } })).toBe(1)
  }, 60_000)

  it("the cron invoices every rental that has fallen due, once: rental + maintenance lines, supply date = due date, total = the rental's", async () => {
    await backdate(olLoan, 1) // the operating lease's first rental (in advance) falls due today
    const run = await runLeaseInvoiceBatch(database() as never, today())
    expect(run).toMatchObject({ ok: true, failed: 0 })
    const rentals = await database().leaseRental.findMany({ where: { loanId: fmlLoan }, orderBy: { periodNo: "asc" }, include: { taxInvoice: { include: { lines: { orderBy: { lineNo: "asc" } } } } } })
    const due = rentals.filter((r) => isoOfDbDate(r.dueDate) <= today())
    expect(due.map((r) => r.periodNo)).toEqual([1, 2, 3])
    for (const rental of rentals) {
      if (!due.includes(rental)) {
        expect(rental.taxInvoiceId).toBeNull()
        continue
      }
      const invoice = rental.taxInvoice
      if (!invoice) throw new Error(`rental ${rental.periodNo} was not invoiced`)
      expect(isoOfDbDate(invoice.supplyDate)).toBe(isoOfDbDate(rental.dueDate))
      expect(invoice.totalInclVatCents).toBe(rental.totalCents)
      expect(invoice.lines.map((l) => [l.exclVatCents, l.vatCents])).toEqual([
        [rental.rentalExclVatCents, Math.floor((rental.rentalExclVatCents * 1500 * 2 + 10_000) / 20_000)],
        [rental.maintenanceExclVatCents, Math.floor((rental.maintenanceExclVatCents * 1500 * 2 + 10_000) / 20_000)],
      ])
      expect(invoice.lines[1].description).toMatch(/^Maintenance/)
    }
    expect(await database().taxInvoice.count({ where: { loanId: fmlLoan } })).toBe(3)
    expect(await database().taxInvoice.count({ where: { loanId: olLoan } })).toBe(1)
    const again = await runLeaseInvoiceBatch(database() as never, today())
    expect(again.issued).toBe(0)
    expect(await database().taxInvoice.count({ where: { loanId: fmlLoan } })).toBe(3)
  }, 60_000)

  it("the lessee reads their rental invoices in the portal; another client and another lease's invoice get 404", async () => {
    const invoice = await database().taxInvoice.findFirstOrThrow({ where: { loanId: olLoan } })
    asClient(fx.lessee)
    const response = await portalInvoice(olLoan, invoice.id)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/pdf")
    const fmlInvoice = await database().taxInvoice.findFirstOrThrow({ where: { loanId: fmlLoan } })
    expect((await portalInvoice(olLoan, fmlInvoice.id)).status).toBe(404)
    asClient(fx.director) // a director of the FML's entity, not the operating lessee
    expect((await portalInvoice(olLoan, invoice.id)).status).toBe(404)
    expect((await portalInvoice(fmlLoan, fmlInvoice.id)).status).toBe(200)
  }, 60_000)

  it("C3: a PRIME move reprices the uninvoiced rentals; every LeaseRental still equals its schedule row", async () => {
    const before = await database().leaseRental.findMany({ where: { loanId: repriceLoan }, orderBy: { periodNo: "asc" } })
    // Tomorrow: booking wrote the contract rate effective on the start date (today).
    const effective = isoOfDbDate(new Date(dbDate(today()).getTime() + 86_400_000))
    const prime = await database().referenceRate.create({ data: { tenantId: fx.tenantId, basis: "PRIME", effectiveDate: dbDate(effective), rate: "0.1150", requestedById: fx.adminA } })
    await database().referenceRate.update({ where: { id: prime.id }, data: { status: "APPROVED", decidedById: fx.adminB, decidedAt: new Date() } })
    const outcome = await database().$transaction((tx) => repriceLoanForReference(tx as never, {
      tenantId: fx.tenantId, loanId: repriceLoan, basis: "PRIME", effectiveDate: effective, runDate: today(), actorUserId: fx.adminA,
    }))
    expect(outcome.kind, JSON.stringify(outcome)).toBe("repriced")
    const after = await database().leaseRental.findMany({ where: { loanId: repriceLoan }, orderBy: { periodNo: "asc" }, include: { schedule: true } })
    const changed = after.filter((r, i) => r.rentalExclVatCents !== before[i].rentalExclVatCents)
    expect(changed.length).toBeGreaterThan(0)
    for (const [i, rental] of after.entries()) {
      expect(rental.totalCents).toBe(rental.schedule.totalDue)
      expect(rental.totalCents).toBe(rental.rentalExclVatCents + rental.maintenanceExclVatCents + rental.vatCents)
      expect(rental.maintenanceExclVatCents).toBe(before[i].maintenanceExclVatCents)
      if (rental.rentalExclVatCents !== before[i].rentalExclVatCents) expect(rental.rentalExclVatCents).toBeGreaterThan(before[i].rentalExclVatCents)
    }
    const loan = await database().loan.findUniqueOrThrow({ where: { id: repriceLoan } })
    expect(loan.totalRepayable).toBe(after.reduce((sum, r) => sum + r.totalCents, 0))
    expect(loan.totalInterest).toBe(0)
  }, 60_000)
  it("a receipt that reaches rentals before their due date invoices them at receipt", async () => {
    const rentals = await database().leaseRental.findMany({ where: { loanId: repriceLoan }, orderBy: { periodNo: "asc" }, take: 2 })
    expect(rentals.every((r) => isoOfDbDate(r.dueDate) > today() && r.taxInvoiceId === null)).toBe(true)
    await applyManualReceipt(database() as unknown as PaymentDb, {
      loanId: repriceLoan, tenantId: fx.tenantId, amount: rentals[0].totalCents + 100, capturedById: fx.officer, reference: "SYNTHETIC-EFT-1",
    })
    const after = await database().leaseRental.findMany({ where: { loanId: repriceLoan }, orderBy: { periodNo: "asc" }, take: 3, include: { taxInvoice: true } })
    expect(after[0].taxInvoice && isoOfDbDate(after[0].taxInvoice.supplyDate)).toBe(today())
    expect(after[1].taxInvoice && isoOfDbDate(after[1].taxInvoice.supplyDate)).toBe(today()) // R1.00 reached rental 2
    expect(after[1].taxInvoice?.totalInclVatCents).toBe(after[1].totalCents)
    expect(after[2].taxInvoiceId).toBeNull()
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, action: "LEASE_RENTAL_INVOICED", entityId: after[0].id } })).toBe(1)
  }, 60_000)

})
