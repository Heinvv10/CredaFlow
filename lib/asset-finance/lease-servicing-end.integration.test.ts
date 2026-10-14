/**
 * Real-Postgres proof of slice 3 C7–C8 through the real routes: a month-to-
 * month extension appends one rental at a time until notice ends it, then
 * returns; a purchase is at least a fresh valuation, is sale-invoiced, and
 * completes only once paid and the eNaTIS change is confirmed; the outcome is
 * one and final; an early termination is quoted (a CPA lessee's on 20
 * business days' notice, with the Reg 5 basis), accepted, invoiced, stops the
 * rentals after it and closes once paid and returned; a CPA lessee's expiry
 * notice is queued once, 40–80 business days before expiry.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-servicing-end.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cpaCancellationDate } from "./lease-termination"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { addMonthsClamped, dbDate, fromDayNumber, isoOfDbDate, toDayNumber } from "./dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { backdateLease, leaseRoutes, payAllOwed } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { runLeaseInvoiceBatch } from "./lease-invoice-batch"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const loans = { extend: "", purchase: "", terminate: "", expiry: "" }
let firstRun = { expiryNotices: -1 }
const today = () => sastCalendarDate(new Date())
const daysAgo = (n: number) => fromDayNumber(toDayNumber(today()) - n)

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const lessee = () => setSession({ id: fx.lessee, email: `lessee@lease-it.test`, role: "CLIENT", tenantId: fx.tenantId })
const routes = () => leaseRoutes(fx.host)
const json = async (response: Response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> })

async function book(body: Parameters<typeof leaseBody>[1], start?: string): Promise<string> {
  const dealId = await approveLease(fx, staff, leaseBody(fx, body))
  await signLease(fx, database(), setSession, dealId, start)
  return payoutAndBook(fx, database(), staff, dealId)
}

suite.sequential("lease end of term and early termination (real Postgres, real routes)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    const short = { contractType: "OPERATING_LEASE" as const, rentalTiming: "ARREARS" as const, entityId: fx.evidenced, preset: { kind: "MONTHLY", periods: 2 }, balloonCents: 100_000_000 }
    loans.extend = await book({ ...short, assetId: fx.assets[1] })
    loans.purchase = await book({ ...short, assetId: fx.assets[0] }) // asset 1 is a registered vehicle
    const firstDue = addMonthsClamped(today(), 1)
    loans.terminate = await book({ assetId: fx.assets[2], contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", clientId: fx.lessee, firstDueDate: firstDue, preset: { kind: "MONTHLY", periods: 24 } }, firstDue)
    loans.expiry = await book({ assetId: fx.assets[3], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", clientId: fx.lessee, preset: { kind: "MONTHLY", periods: 6 } })
    await backdateLease(database(), loans.extend, 2)
    await backdateLease(database(), loans.purchase, 2)
    await backdateLease(database(), loans.terminate, 1) // started today: the first rental (in advance) is due today
    await backdateLease(database(), loans.expiry, 3) // expires in about three months: inside 40–80 business days
    firstRun = await runLeaseInvoiceBatch(database() as never, today())
    expect(firstRun).toMatchObject({ ok: true })
  }, 600_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("C7 EXTEND: month to month, one rental at a time at the last rental, until notice ends it; then a return", async () => {
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await json(await routes().endOfTerm(loans.extend, "elect", { outcome: "EXTEND" }))).body.status).toBe("EXTENDING")
    const run = await runLeaseInvoiceBatch(database() as never, today())
    expect(run.extensionRentals).toBe(1)
    const rentals = await database().leaseRental.findMany({ where: { loanId: loans.extend }, orderBy: { periodNo: "asc" } })
    expect(rentals).toHaveLength(3)
    expect([rentals[2].rentalExclVatCents, rentals[2].totalCents]).toEqual([rentals[1].rentalExclVatCents, rentals[1].totalCents])
    expect(isoOfDbDate(rentals[2].dueDate)).toBe(addMonthsClamped(isoOfDbDate(rentals[1].dueDate), 1))
    expect((await runLeaseInvoiceBatch(database() as never, today())).extensionRentals).toBe(0) // one period at a time
    expect((await json(await routes().endOfTerm(loans.extend, "inspection", { inspectedOn: today(), condition: "Synthetic: good", damage: [] }))).status).toBe(409) // still extending
    expect((await json(await routes().endOfTerm(loans.extend, "extension-notice", { noticeOn: addMonthsClamped(today(), -1) }))).status).toBe(200)
    expect((await json(await routes().endOfTerm(loans.extend, "inspection", { inspectedOn: today(), condition: "Synthetic: good", damage: [] }))).status).toBe(200)
    expect((await json(await routes().endOfTerm(loans.extend, "elect", { outcome: "PURCHASE" }))).status).toBe(409) // one outcome
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await json(await routes().endOfTerm(loans.extend, "invoice"))).status).toBe(200)
    await payAllOwed(database(), fx, loans.extend)
    expect((await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId: loans.extend } })).status).toBe("COMPLETED")
    expect(await database().leaseEndOfTerm.update({ where: { loanId: loans.extend }, data: { status: "INVOICED" } }).catch((e: Error) => e.message)).toMatch(/final/)
  }, 120_000)

  it("C7 PURCHASE: at least a fresh valuation, sale-invoiced, closed once paid and the eNaTIS change confirmed", async () => {
    const asset = fx.assets[0]
    const valuation = (amountCents: number, valuedOn: string) => database().assetValuation.create({
      data: { tenantId: fx.tenantId, assetId: asset, valuedOn: dbDate(valuedOn), source: "ASSESSOR", valuerName: "TEST Assessors", amountCents, createdById: fx.officer },
    })
    const stale = await valuation(70_000_000, daysAgo(40))
    const fresh = await valuation(70_000_000, today())
    staff(fx.officer, "CREDIT_OFFICER")
    const elect = (price: number, valuationId: string) => routes().endOfTerm(loans.purchase, "elect", { outcome: "PURCHASE", purchasePriceExclVatCents: price, valuationId })
    expect((await json(await elect(72_000_000, stale.id))).body.reason).toBe("valuation_stale")
    expect((await json(await elect(69_999_999, fresh.id))).body.reason).toBe("below_market")
    expect(await database().leaseEndOfTerm.create({ data: { tenantId: fx.tenantId, loanId: loans.purchase, origin: "EXPIRY", outcome: "PURCHASE", purchasePriceExclVatCents: 1, purchaseValuationId: fresh.id } })
      .catch((e: Error) => e.message)).toMatch(/market value/)
    expect((await json(await elect(72_000_000, fresh.id))).status).toBe(200)
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await json(await routes().endOfTerm(loans.purchase, "invoice"))).status).toBe(200)
    const end = await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId: loans.purchase }, include: { taxInvoice: { include: { lines: true } } } })
    expect(end.taxInvoice?.lines.map((l) => [l.description.startsWith("Sale of"), l.exclVatCents, l.vatCents])).toEqual([[true, 72_000_000, 10_800_000]])
    await payAllOwed(database(), fx, loans.purchase)
    expect((await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId: loans.purchase } })).status).toBe("INVOICED") // the eNaTIS change is outstanding
    expect((await json(await routes().endOfTerm(loans.purchase, "natis-confirmed"))).status).toBe(200)
    expect((await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId: loans.purchase } })).status).toBe("COMPLETED")
    expect((await database().financedAsset.findUniqueOrThrow({ where: { id: asset } })).lessorStatus).toBe("SOLD_TO_LESSEE")
    expect((await database().loan.findUniqueOrThrow({ where: { id: loans.purchase } })).status).toBe("COMPLETED")
  }, 120_000)

  it("C8: a CPA lessee's quote on 20 business days' notice with the Reg 5 basis; accept → invoice, rentals after it stop; pay + return → closed", async () => {
    lessee()
    const quoted = await json(await routes().portalQuote(loans.terminate))
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(200)
    const quote = await database().leaseTerminationQuote.findUniqueOrThrow({ where: { id: String(quoted.body.quoteId) } })
    expect(isoOfDbDate(quote.terminationDate)).toBe(cpaCancellationDate(today()))
    expect(quote.basis).toMatch(/Regulation 5\(2\)/)
    expect(quote.totalCents).toBe(quote.pvCents + quote.penaltyCents + quote.invoiceVatCents + quote.arrearsCents)
    setSession({ id: fx.director, email: fx.directorEmail, role: "CLIENT", tenantId: fx.tenantId })
    expect((await routes().portalAccept(loans.terminate, quote.id)).status).toBe(404) // not the lessee
    lessee()
    expect((await json(await routes().portalAccept(loans.terminate, quote.id))).status).toBe(200)
    const rentals = await database().leaseRental.findMany({ where: { loanId: loans.terminate } })
    const after = rentals.filter((r) => r.dueDate.getTime() > quote.terminationDate.getTime())
    expect(after.length).toBe(quote.remainingRentals)
    expect(after.every((r) => r.cancelledAt !== null)).toBe(true)
    const accepted = await database().leaseTerminationQuote.findUniqueOrThrow({ where: { id: quote.id }, include: { taxInvoice: { include: { lines: true } } } })
    expect(accepted.taxInvoice?.totalInclVatCents).toBe(quote.invoiceExclVatCents + quote.invoiceVatCents)
    expect((await routes().portalAccept(loans.terminate, quote.id)).status).toBe(409) // once
    const end = await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId: loans.terminate } })
    expect(end).toMatchObject({ origin: "EARLY_TERMINATION", outcome: "RETURN", status: "ELECTED" })
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await json(await routes().endOfTerm(loans.terminate, "inspection", { inspectedOn: today(), condition: "Synthetic: good", damage: [] }))).status).toBe(200)
    staff(fx.adminA, "LOAN_ADMIN")
    expect((await json(await routes().endOfTerm(loans.terminate, "invoice"))).status).toBe(200)
    await payAllOwed(database(), fx, loans.terminate)
    expect((await database().loan.findUniqueOrThrow({ where: { id: loans.terminate } })).status).toBe("COMPLETED")
  }, 120_000)

  it("C7: a CPA lessee's expiry notice is queued once, 40–80 business days before expiry, to staff (nothing is sent)", async () => {
    expect(firstRun.expiryNotices).toBe(1) // the expiring CPA lease only; the 24-month one is years out
    const notice = await database().leaseExpiryNotice.findUniqueOrThrow({ where: { loanId: loans.expiry } })
    expect(isoOfDbDate(notice.queuedOn)).toBe(today())
    expect(await database().notification.count({ where: { tenantId: fx.tenantId, type: "LEASE_EXPIRY_NOTICE", entityId: loans.expiry } })).toBeGreaterThan(0)
    expect((await runLeaseInvoiceBatch(database() as never, today())).expiryNotices).toBe(0)
    expect(await database().message.count({ where: { tenantId: fx.tenantId, direction: "OUTBOUND" } })).toBe(0) // nothing is sent
    expect(await database().emailLog.count({ where: { tenantId: fx.tenantId } })).toBe(0)
  }, 60_000)
})
