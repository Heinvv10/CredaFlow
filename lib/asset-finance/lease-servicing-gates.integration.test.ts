/**
 * Real-Postgres proof, through the real routes, of what must hold before a
 * lease's end of term is billed (lib/asset-finance/lease-end-billing.ts) and
 * that a refused step keeps nothing: every rental invoiced first
 * (rentals_pending), no claim open (open_claims), damage billed by someone
 * other than the inspector (four_eyes), the inspection never in the future,
 * and a lessee with no address refuses the invoice and the termination
 * acceptance (recipient) with the fund, its movements, the rentals, the quote,
 * the schedule and the end of term unchanged.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-servicing-gates.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { fromDayNumber, toDayNumber } from "./dates"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { backdateLease, leaseDocument, leaseRoutes, testSetup } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { runLeaseInvoiceBatch } from "./lease-invoice-batch"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const loans = { fml: "", running: "", pending: "" }
const today = () => sastCalendarDate(new Date())

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const routes = () => leaseRoutes(fx.host)
const json = async (response: Response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> })

async function book(body: Parameters<typeof leaseBody>[1], months: number): Promise<string> {
  const dealId = await approveLease(fx, staff, leaseBody(fx, { entityId: fx.evidenced, balloonCents: 100_000_000, ...body }))
  await signLease(fx, database(), setSession, dealId)
  const loanId = await payoutAndBook(fx, database(), staff, dealId)
  await backdateLease(database(), loanId, months)
  return loanId
}

/** Test setup: the lessee entity's address (the tax invoice's recipient) removed, or put back. */
const address = (present: boolean) => testSetup(database(), [
  `UPDATE "BusinessEntity" SET "addressLine1" = $2, "city" = $3 WHERE "id" = $1`, fx.evidenced, present ? "9 Synthetic Yard" : null, present ? "Johannesburg" : null,
])

/** Everything a refused step could have written for the loan. */
async function snapshot(loanId: string) {
  const d = database()
  return {
    loan: await d.loan.findUniqueOrThrow({ where: { id: loanId }, select: { status: true, principal: true, totalRepayable: true, outstandingPrincipal: true, maturityDate: true } }),
    schedule: await d.repaymentSchedule.findMany({ where: { loanId }, orderBy: { installmentNo: "asc" }, select: { id: true, totalDue: true, dueDate: true } }),
    rentals: await d.leaseRental.findMany({ where: { loanId }, orderBy: { periodNo: "asc" }, select: { id: true, cancelledAt: true, taxInvoiceId: true } }),
    invoices: await d.taxInvoice.count({ where: { loanId } }),
    fund: await d.maintenanceFund.findUnique({ where: { loanId }, select: { settledAt: true, settledBalanceCents: true, movements: { select: { id: true, kind: true } } } }),
    quotes: await d.leaseTerminationQuote.findMany({ where: { loanId }, select: { id: true, status: true, taxInvoiceId: true, scheduleId: true } }),
    end: await d.leaseEndOfTerm.findUnique({ where: { loanId }, select: { status: true, taxInvoiceId: true, scheduleId: true, excessUsageCents: true, fundSettlementCents: true } }),
    asset: await d.financedAsset.findFirstOrThrow({ where: { loans: { some: { id: loanId } } }, select: { lessorStatus: true } }),
  }
}

suite.sequential("lease servicing gates: billing prerequisites, and a refusal keeps nothing (real Postgres, real routes)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    loans.fml = await book({
      assetId: fx.assets[1], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", preset: { kind: "MONTHLY", periods: 3 },
      maintenanceRiskModel: "LESSEE_SETTLED", escalationRate: "0",
    }, 3)
    loans.running = await book({ assetId: fx.assets[2], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", preset: { kind: "MONTHLY", periods: 36 } }, 2)
    expect((await runLeaseInvoiceBatch(database() as never, today())).ok).toBe(true)
    // Booked after the run: its rentals have fallen due but are not invoiced.
    loans.pending = await book({ assetId: fx.assets[3], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", preset: { kind: "MONTHLY", periods: 2 } }, 2)
  }, 600_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("rentals_pending: an end of term is billed only once every rental has its tax invoice", async () => {
    staff(fx.officer, "CREDIT_OFFICER")
    expect((await json(await routes().endOfTerm(loans.pending, "elect", { outcome: "RETURN" }))).status).toBe(200)
    expect((await json(await routes().endOfTerm(loans.pending, "inspection", { inspectedOn: today(), condition: "Synthetic: good", damage: [] }))).status).toBe(200)
    staff(fx.adminA, "LOAN_ADMIN")
    const refused = await json(await routes().endOfTerm(loans.pending, "invoice"))
    expect([refused.status, refused.body.reason]).toEqual([409, "rentals_pending"])
    expect((await database().leaseEndOfTerm.findUniqueOrThrow({ where: { loanId: loans.pending } })).status).toBe("INSPECTED")
  }, 60_000)

  it("the inspection is never dated in the future; open_claims, then four_eyes, hold the invoice back", async () => {
    staff(fx.adminA, "LOAN_ADMIN")
    const doc = await leaseDocument(database(), fx, loans.fml)
    const claim = await json(await routes().claim(loans.fml, { supplierId: fx.supplier, providerInvoiceDocumentId: doc, amountExclVatCents: 100_000, description: "Synthetic: filter service" }))
    expect(claim.status, JSON.stringify(claim.body)).toBe(200)
    expect((await json(await routes().endOfTerm(loans.fml, "elect", { outcome: "RETURN" }))).status).toBe(200)
    const inspection = (inspectedOn: string) => routes().endOfTerm(loans.fml, "inspection", {
      inspectedOn, condition: "Synthetic: dented bucket", finalReading: 600, damage: [{ description: "Dented bucket", amountExclVatCents: 250_000 }],
    })
    const future = await json(await inspection(fromDayNumber(toDayNumber(today()) + 1)))
    expect([future.status, future.body.reason]).toEqual([400, "invalid_inspectedOn"])
    expect((await json(await inspection(today()))).status).toBe(200) // inspected by adminA, damage assessed
    const open = await json(await routes().endOfTerm(loans.fml, "invoice"))
    expect([open.status, open.body.reason]).toEqual([409, "open_claims"])
    staff(fx.adminB, "LOAN_ADMIN")
    expect((await json(await routes().claimAction(loans.fml, String(claim.body.claimId), "reject", { reason: "Synthetic: not covered" }))).body.status).toBe("REJECTED")
    staff(fx.adminA, "LOAN_ADMIN")
    const own = await json(await routes().endOfTerm(loans.fml, "invoice"))
    expect([own.status, own.body.reason]).toEqual([409, "four_eyes"])
  }, 60_000)

  it("recipient: with no lessee address the invoice is refused and nothing is written; with it, the invoice goes through", async () => {
    await address(false)
    const before = await snapshot(loans.fml)
    expect(before.fund?.settledAt).toBeNull()
    staff(fx.adminB, "LOAN_ADMIN")
    const refused = await json(await routes().endOfTerm(loans.fml, "invoice"))
    expect([refused.status, refused.body.reason]).toEqual([422, "recipient"])
    expect(await snapshot(loans.fml)).toEqual(before)
    await address(true)
    const invoiced = await json(await routes().endOfTerm(loans.fml, "invoice"))
    expect([invoiced.status, invoiced.body.status], JSON.stringify(invoiced.body)).toEqual([200, "INVOICED"])
    const after = await snapshot(loans.fml)
    expect(after.fund?.settledAt).not.toBeNull()
    expect(after.fund?.movements.map((m) => m.kind)).toContain("SETTLEMENT_REFUND") // 3 × R4 500 in, the claim rejected
    expect(after.invoices).toBe(before.invoices + 1) // the damage (200 h used of 375 allowed: no excess)
  }, 60_000)

  it("recipient: with no lessee address the termination is not accepted and nothing is written", async () => {
    staff(fx.adminA, "LOAN_ADMIN")
    const quoted = await json(await routes().quote(loans.running))
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(200)
    await address(false)
    const before = await snapshot(loans.running)
    expect(before.quotes).toEqual([{ id: quoted.body.quoteId, status: "QUOTED", taxInvoiceId: null, scheduleId: null }])
    expect(before.rentals.filter((r) => r.taxInvoiceId === null).length).toBeGreaterThan(0) // rentals an acceptance would cancel
    staff(fx.adminB, "LOAN_ADMIN")
    const refused = await json(await routes().accept(loans.running, String(quoted.body.quoteId)))
    expect([refused.status, refused.body.reason]).toEqual([422, "recipient"])
    expect(await snapshot(loans.running)).toEqual(before)
    expect(before.end).toBeNull()
    await address(true)
  }, 60_000)
})
