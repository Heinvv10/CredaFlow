/**
 * Real-Postgres proof of slice 3 C11, collections on a lease: a lease is
 * booked through the real routes, its dates move back so five rentals are
 * missed, the charges sweep posts the agreement's
 * NON_NCA default interest and one collection fee per missed rental, and the
 * figures equal an independent hand calculation to the cent. Receipts through
 * the real manual-receipt path settle default interest, then fees, then the
 * oldest rental, and a receipt reaching a rental not yet due issues its tax
 * invoice at receipt. A lease 100+ days in arrears is never eligible for a
 * Section 129 notice: not by the eligibility rule, not by the single or bulk
 * issuing routes, and no notice record is written. Dunning stays available.
 *
 * Independent working (cents; the lease's own rows supply each rental's total,
 * the interest is derived here from first principles):
 *   rate = FIXED 13.5% contract + 5% signed arrears margin = 18.5% a year
 *   a rental falling due on day u accrues on every COMPLETE day after u and
 *   before the as-of day D: (D - 1 - u) days, on its whole VAT-inclusive total
 *   interest = round-half-up( sum(total x days x 185) / (1000 x 365) )
 *   one collection fee (R250.00) per missed rental.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-collections.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { sweepTenantCharges, type SweepDb } from "@/lib/loan/charges-sweep"
import { evaluateCollectionsEligibility, SECTION129_NON_NCA_REASON } from "@/lib/collections/section129-eligibility"
import { POST as section129Route } from "@/app/api/loans/section129/route"
import { POST as section129BulkRoute } from "@/app/api/loans/section129/bulk/route"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { isoOfDbDate } from "./dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { runLeaseInvoiceBatch } from "./lease-invoice-batch"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const DAY = 86_400_000
const FEE = 25_000
const RATE_BP = 185 // 13.5% contract + 5% margin, in tenths of a percent
let fx: LeaseFixture
let loanId = ""
let asOf = ""

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const dayNo = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY
const loan = () => database().loan.findUniqueOrThrow({ where: { id: loanId } })
const schedule = () => database().repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" } })
const rentals = () => database().leaseRental.findMany({ where: { loanId }, orderBy: { periodNo: "asc" }, include: { taxInvoice: true } })
const receipt = (amount: number, reference: string) => applyManualReceipt(database() as unknown as PaymentDb, {
  loanId, tenantId: fx.tenantId, amount, paymentMethod: "EFT", reference, capturedById: fx.adminA,
})
const sweep = async () => {
  const swept = await sweepTenantCharges(database() as unknown as SweepDb, fx.tenantId, new Date(), { source: "lease-collections-it" })
  expect(swept.failures).toEqual([])
}
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

/** Test setup only (triggers off): move the booked lease back `days`. */
async function backdateDays(days: number): Promise<void> {
  const d = database()
  const i = `INTERVAL '${days} days'`
  await d.$transaction([
    d.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    d.$executeRawUnsafe(`UPDATE "Loan" SET "startDate" = "startDate" - ${i}, "maturityDate" = "maturityDate" - ${i}, "nextPaymentDate" = "nextPaymentDate" - ${i} WHERE "id" = $1`, loanId),
    d.$executeRawUnsafe(`UPDATE "RepaymentSchedule" SET "dueDate" = "dueDate" - ${i} WHERE "loanId" = $1`, loanId),
    d.$executeRawUnsafe(`UPDATE "LeaseRental" SET "dueDate" = ("dueDate" - ${i})::date WHERE "loanId" = $1`, loanId),
    d.$executeRawUnsafe(`UPDATE "ContractRate" SET "effectiveDate" = ("effectiveDate" - ${i})::date WHERE "loanId" = $1`, loanId),
  ])
}

/** Independent: half-up cents of sum(total x completeDays x RATE_BP) / (1000 x 365), over the rentals past due. */
function handInterest(rows: Array<{ dueIso: string; totalCents: number }>): number {
  const numerator = sum(rows.map((r) => r.totalCents * Math.max(0, dayNo(asOf) - 1 - dayNo(r.dueIso)) * RATE_BP))
  const denominator = 1000 * 365
  return Math.floor((2 * numerator + denominator) / (2 * denominator))
}

suite.sequential("lease collections: book → miss → default interest → receipt → balances; no s129 (real Postgres)", () => {
  beforeAll(async () => {
    vi.stubEnv("TRUSTED_PROXY", "1")
    const d = database()
    fx = await createLeaseFixture(d, t)
    // The signed arrears terms are the product's at preparation: a 5% margin and a R250 collection fee.
    await d.loanProduct.update({ where: { id: fx.product }, data: { nonNcaDefaultInterestMargin: "0.05", nonNcaCollectionFeeCents: FEE } })
    const dealId = await approveLease(fx, staff, leaseBody(fx, {
      assetId: fx.assets[0], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced,
      rateBasis: "FIXED", rateMargin: undefined, fixedRate: "0.135", preset: { kind: "MONTHLY", periods: 24 },
    }))
    await signLease(fx, d, setSession, dealId)
    loanId = await payoutAndBook(fx, d, staff, dealId)
    // Rental 1 (a month after the start) moves to 130 days ago: rentals 1–5 have fallen due (5 about a week ago), rental 6 is ahead.
    const firstDue = isoOfDbDate((await rentals())[0].dueDate)
    asOf = sastCalendarDate(new Date())
    await backdateDays(dayNo(firstDue) - (dayNo(asOf) - 130))
    // Charges are live from before the first rental fell due.
    await d.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date(Date.now() - 400 * DAY) } })
    // The daily cron invoices every rental whose due date has arrived (supply date = the due date).
    expect(await runLeaseInvoiceBatch(d as never, asOf)).toMatchObject({ ok: true, issued: 5 })
    await sweep()
  }, 600_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (!db) return
    const tenantId = dealFixtureTenantId(t)
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.loanCharge.deleteMany({ where: { tenantId } }),
      db.payment.deleteMany({ where: { tenantId } }),
      db.loanNote.deleteMany({ where: { tenantId } }),
      db.auditLog.deleteMany({ where: { tenantId, entityId: loanId } }),
    ]).catch(() => undefined)
    await cleanupLeaseRows(db, tenantId).catch(() => undefined)
    await cleanupDealFixture(db, { tenantId })
    await db.$disconnect()
  }, 60_000)

  it("the lease is a NON_NCA loan carrying the signed arrears terms", async () => {
    expect(await loan()).toMatchObject({ ncaRegime: "NON_NCA", contractType: "OPERATING_LEASE", nonNcaCollectionFeeCents: FEE, entityId: fx.evidenced })
    expect((await loan()).nonNcaDefaultInterestMargin?.toString()).toBe("0.05")
  })

  it("five missed rentals: one fee each and default interest equal to the hand calculation, to the cent; arrears are the five rentals", async () => {
    const rows = await rentals()
    const missed = rows.slice(0, 5).map((r) => ({ dueIso: isoOfDbDate(r.dueDate), totalCents: r.totalCents }))
    const expectedInterest = handInterest(missed)
    expect(expectedInterest).toBeGreaterThan(0)

    const charges = await database().loanCharge.findMany({ where: { loanId }, orderBy: { day: "asc" } })
    expect(charges.filter((c) => c.type === "COLLECTION_FEE").map((c) => c.amount)).toEqual([FEE, FEE, FEE, FEE, FEE])
    expect(charges.every((c) => c.type === "COLLECTION_FEE" || c.type === "DEFAULT_INTEREST")).toBe(true) // no s129 letter charge, no service fee
    const interest = sum(charges.filter((c) => c.type === "DEFAULT_INTEREST").map((c) => c.amount))
    expect(interest).toBe(expectedInterest)

    const owed = sum(missed.map((r) => r.totalCents))
    expect(await loan()).toMatchObject({
      arrearsAmount: owed, chargesAccrued: 5 * FEE + expectedInterest, chargesOutstanding: 5 * FEE + expectedInterest,
      daysInArrears: dayNo(asOf) - dayNo(missed[0].dueIso),
    })
    expect((await loan()).daysInArrears).toBeGreaterThan(90)
    // The rentals' invoices carry the supply date they fell due on.
    expect(rows.slice(0, 5).map((r) => r.taxInvoice && isoOfDbDate(r.taxInvoice.supplyDate))).toEqual(missed.map((r) => r.dueIso))
    expect(rows[5].taxInvoiceId).toBeNull()
  })

  it("a lease 100+ days in arrears is not eligible for Section 129, and dunning still applies", async () => {
    const l = await loan()
    expect(l.arrearsAmount).toBeGreaterThan(0)
    const state = { status: l.status, ncaRegime: l.ncaRegime, arrearsAmount: l.arrearsAmount, outstandingPrincipal: l.outstandingPrincipal, daysInArrears: l.daysInArrears }
    expect(evaluateCollectionsEligibility(state, "SECTION_129")).toMatchObject({ eligible: false, reason: SECTION129_NON_NCA_REASON })
    // Only the regime stops it: the same figures on an NCA agreement are eligible.
    expect(evaluateCollectionsEligibility({ ...state, ncaRegime: "NCA" }, "SECTION_129").eligible).toBe(true)
    expect(evaluateCollectionsEligibility(state, "DUNNING").eligible).toBe(true)

    // The issuing routes agree: the single route refuses; the bulk route skips the lease; nothing is written.
    const request = (path: string, body: unknown) => new NextRequest(`http://${fx.host}${path}`, {
      method: "POST", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify(body),
    })
    staff(fx.adminA, "LOAN_ADMIN")
    const single = await section129Route(request("/api/loans/section129", { loanId }))
    expect(single.status).toBe(422)
    expect(((await single.json()) as { error: string }).error).toContain(SECTION129_NON_NCA_REASON)
    const bulk = await section129BulkRoute(request("/api/loans/section129/bulk", {}))
    expect(bulk.status).toBe(200)
    expect(await bulk.json()).toMatchObject({ sent: 0, failed: 0, skipped: 1, results: [] }) // the lease is the tenant's only loan 90+ days in arrears
    expect(await database().complianceRecord.count({ where: { tenantId: fx.tenantId, type: "SECTION_129_NOTICE" } })).toBe(0)
  }, 60_000)

  it("a receipt smaller than the default interest owed goes wholly to default interest: rentals and arrears untouched", async () => {
    const before = await loan()
    const result = await receipt(1_000, "SYNTHETIC-LEASE-1")
    expect(result.payment).toMatchObject({ amount: 1_000, defaultInterestAllocated: 1_000, chargeFeesAllocated: 0, allocationStatus: "ALLOCATED" })
    expect((await schedule()).every((r) => r.totalPaid === 0)).toBe(true)
    expect(await loan()).toMatchObject({ arrearsAmount: before.arrearsAmount, chargesOutstanding: before.chargesOutstanding - 1_000 })
  })

  it("a receipt pays the rest of the default interest, the five fees, the oldest rental and part of the next", async () => {
    const before = await loan()
    const [r1, r2, r3, r4, r5] = (await rentals()).map((r) => r.totalCents)
    const interestOwed = before.chargesOutstanding - 5 * FEE
    const amount = interestOwed + 5 * FEE + r1 + 5_000
    const result = await receipt(amount, "SYNTHETIC-LEASE-2")
    expect(result.payment).toMatchObject({ amount, defaultInterestAllocated: interestOwed, chargeFeesAllocated: 5 * FEE })
    const rows = await schedule()
    expect(rows[0]).toMatchObject({ status: "PAID", totalPaid: r1 })
    expect(rows[1].totalPaid).toBe(5_000)
    expect(rows.slice(2).every((r) => r.totalPaid === 0)).toBe(true)
    const after = await loan()
    expect(after).toMatchObject({
      arrearsAmount: r2 + r3 + r4 + r5 - 5_000, chargesOutstanding: 0, chargesAccrued: before.chargesAccrued, totalPaid: r1 + 5_000,
      outstandingPrincipal: before.principal - r1 - 5_000, status: "ACTIVE",
    })
    expect(after.daysInArrears).toBe(dayNo(asOf) - dayNo(isoOfDbDate((await rentals())[1].dueDate)))
  })

  it("clearing the arrears and R100.00 more settles the rentals due and invoices the not-yet-due rental it reaches, at receipt", async () => {
    const [, r2, r3, r4, r5, r6] = await rentals()
    const amount = r2.totalCents - 5_000 + r3.totalCents + r4.totalCents + r5.totalCents + 10_000
    const result = await receipt(amount, "SYNTHETIC-LEASE-3")
    expect(result.excessPayment).toBeNull()
    const rows = await schedule()
    expect(rows.slice(0, 5).every((r) => r.status === "PAID" && r.totalPaid === r.totalDue)).toBe(true)
    expect(rows[5].totalPaid).toBe(10_000)
    expect(rows.slice(6).every((r) => r.totalPaid === 0)).toBe(true)
    const after = await loan()
    expect(after).toMatchObject({
      arrearsAmount: 0, daysInArrears: 0, chargesOutstanding: 0, status: "ACTIVE",
      outstandingPrincipal: sum(rows.map((r) => r.totalDue)) - sum((await rentals()).slice(0, 5).map((r) => r.totalCents)) - 10_000,
    })
    // Rental 6 was not yet due: the receipt invoiced it, on the receipt's day, for its total. Rental 7 is untouched.
    const sixth = (await rentals())[5]
    expect(isoOfDbDate(sixth.dueDate) > asOf).toBe(true)
    expect(sixth.taxInvoice).toMatchObject({ totalInclVatCents: r6.totalCents, vatCents: r6.vatCents })
    expect(sixth.taxInvoice && isoOfDbDate(sixth.taxInvoice.supplyDate)).toBe(asOf)
    expect((await rentals())[6].taxInvoiceId).toBeNull()
    expect(await database().taxInvoice.count({ where: { loanId } })).toBe(6)
  })

  it("with nothing overdue the sweep accrues nothing more: the paid-up lease owes no charges", async () => {
    const before = await loan()
    await sweep()
    expect(await loan()).toMatchObject({ chargesAccrued: before.chargesAccrued, chargesOutstanding: 0, arrearsAmount: 0 })
  })
})
