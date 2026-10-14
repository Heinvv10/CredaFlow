/**
 * Each slice 3 C7–C8 database rule refuses its attack, and is what refuses
 * it: the same attack goes through with that one rule removed (inside a
 * rolled-back transaction). End of term, damage, the asset's lessor status,
 * termination quotes, the rentals after booking and the lease charge row.
 *
 *   RUN_ASSET_FINANCE_LEASE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/lease-servicing-rules-end.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { cleanupDealFixture, dealFixtureTenantId } from "./deal.integration-fixture"
import { addMonthsClamped, dbDate, isoOfDbDate } from "./dates"
import { dueDateInstant } from "./schedule-records"
import { appendLeaseCharge } from "./lease-charges"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "./lease.integration-fixture"
import { attempt, backdateLease, ruleRefuses } from "./lease-servicing.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { runLeaseInvoiceBatch } from "./lease-invoice-batch"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_LEASE_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const loans = { expired: "", running: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]
const today = () => sastCalendarDate(new Date())

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_LEASE_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-it.test`, role, tenantId: fx.tenantId })
const refuses = (rule: Parameters<typeof ruleRefuses>[1], message: RegExp, attack: (tx: Tx) => Promise<unknown>) => ruleRefuses(database(), rule, message, attack)

async function book(assetId: string, periods: number): Promise<string> {
  const dealId = await approveLease(fx, staff, leaseBody(fx, {
    assetId, contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced, preset: { kind: "MONTHLY", periods }, balloonCents: 100_000_000,
  }))
  await signLease(fx, database(), setSession, dealId)
  const loanId = await payoutAndBook(fx, database(), staff, dealId)
  await backdateLease(database(), loanId, 2)
  return loanId
}

const elect = (tx: Tx, data: Record<string, unknown> = {}) => tx.leaseEndOfTerm.create({
  data: { tenantId: fx.tenantId, loanId: loans.expired, origin: "EXPIRY", outcome: "RETURN", status: "ELECTED", ...data }, select: { id: true },
})
const inspection = () => ({ inspectedOn: dbDate(today()), inspectedById: fx.officer, inspectionCondition: "Synthetic: scratched" })
const inspected = async (tx: Tx) => {
  const { id } = await elect(tx)
  await tx.leaseEndOfTerm.update({ where: { id }, data: { status: "INSPECTED", ...inspection() } })
  return id
}
const quote = (tx: Tx, data: Record<string, unknown> = {}) => tx.leaseTerminationQuote.create({
  data: {
    tenantId: fx.tenantId, loanId: loans.running, quotedOn: dbDate(today()), terminationDate: dbDate(today()), validUntil: dbDate(today()),
    cpaCancellation: false, remainingRentals: 1, pvCents: 100, penaltyCents: 10, arrearsCents: 0, invoiceExclVatCents: 110, invoiceVatCents: 17,
    totalCents: 127, basis: "Synthetic basis for a test", status: "QUOTED", ...data,
  },
  select: { id: true },
})
/** Nothing to invoice (only arrears): an accepted quote needs no invoice or charge row (LeaseTerminationQuote_accepted_billed). */
const unbilled = { pvCents: 0, penaltyCents: 0, invoiceExclVatCents: 0, invoiceVatCents: 0, arrearsCents: 127 }
const accept = (tx: Tx, id: string) => tx.leaseTerminationQuote.update({ where: { id }, data: { status: "ACCEPTED", acceptedAt: new Date(), acceptedById: fx.adminA } })

const invoiceReturn = (tx: Tx) => issueTaxInvoice(tx as never, {
  tenantId: fx.tenantId, loanId: loans.expired, issueDate: today(), supplyDate: today(), createdById: fx.adminA,
  recipient: { name: "TEST Lessee (Pty) Ltd", address: "9 Synthetic Yard, Johannesburg, 2001", vatNumber: null },
  lines: [{ description: "Damage: synthetic dent", quantity: 1, unitExclVatCents: 100_000 }],
})

/** The real end-of-term billing path, in `tx`: invoice, charge row, linked. Returns the charge row. */
async function chargedReturn(tx: Tx): Promise<string> {
  const id = await inspected(tx)
  const invoice = await invoiceReturn(tx)
  const rowId = await appendLeaseCharge(tx as never, { tenantId: fx.tenantId, loanId: loans.expired, amountCents: invoice.totalInclVatCents, dueDate: today(), actorUserId: fx.adminA, why: "test" })
  await tx.leaseEndOfTerm.update({ where: { id }, data: { status: "INVOICED", taxInvoiceId: invoice.id, scheduleId: rowId } })
  return rowId
}

suite.sequential("lease servicing rules: end of term, termination, rentals, charge rows (each rule removed → the attack goes through)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(database(), t)
    loans.expired = await book(fx.assets[1], 2)
    loans.running = await book(fx.assets[2], 36)
    expect((await runLeaseInvoiceBatch(database() as never, today())).ok).toBe(true)
  }, 600_000)

  afterAll(async () => {
    await cleanupLeaseRows(database(), dealFixtureTenantId(t)).catch(() => undefined)
    await cleanupDealFixture(database(), { tenantId: dealFixtureTenantId(t) })
    await db?.$disconnect()
  }, 60_000)

  it("LeaseEndOfTerm_shape: a return carries no purchase price", async () => {
    await refuses({ table: "LeaseEndOfTerm", constraint: "LeaseEndOfTerm_shape" }, /LeaseEndOfTerm_shape/, (tx) => elect(tx, { purchasePriceExclVatCents: 5 }))
  })

  it("LeaseEndOfTerm_guard: an end of term is elected, not written invoiced", async () => {
    await refuses({ table: "LeaseEndOfTerm", trigger: "LeaseEndOfTerm_guard" }, /nothing billed yet/, (tx) => elect(tx, { status: "INVOICED", ...inspection() }))
  })

  it("LeaseDamageItem_shape: damage has an amount", async () => {
    await refuses({ table: "LeaseDamageItem", constraint: "LeaseDamageItem_shape" }, /LeaseDamageItem_shape/,
      async (tx) => tx.leaseDamageItem.create({ data: { tenantId: fx.tenantId, endOfTermId: await inspected(tx), description: "Synthetic dent", amountExclVatCents: 0 } }))
  })

  it("LeaseDamageItem_guard: damage is recorded on an inspected return", async () => {
    await refuses({ table: "LeaseDamageItem", trigger: "LeaseDamageItem_guard" }, /inspected, not yet invoiced/,
      async (tx) => tx.leaseDamageItem.create({ data: { tenantId: fx.tenantId, endOfTermId: (await elect(tx)).id, description: "Synthetic dent", amountExclVatCents: 1 } }))
  })

  it("FinancedAsset_lessor_status: a lessor status is never cleared", async () => {
    await refuses({ table: "FinancedAsset", trigger: "FinancedAsset_lessor_status" }, /not cleared/, async (tx) => {
      await tx.financedAsset.update({ where: { id: fx.assets[1] }, data: { lessorStatus: "RETURNED_TO_STOCK", lessorStatusAt: new Date() } })
      await tx.financedAsset.update({ where: { id: fx.assets[1] }, data: { lessorStatus: null } })
    })
  })

  it("LeaseTerminationQuote_amounts: a quote's total is its parts", async () => {
    await refuses({ table: "LeaseTerminationQuote", constraint: "LeaseTerminationQuote_amounts" }, /LeaseTerminationQuote_amounts/, (tx) => quote(tx, { totalCents: 128 }))
  })

  it("LeaseTerminationQuote_guard: a quote is written QUOTED", async () => {
    await refuses({ table: "LeaseTerminationQuote", trigger: "LeaseTerminationQuote_guard" }, /written QUOTED/,
      (tx) => quote(tx, { ...unbilled, status: "ACCEPTED", acceptedAt: new Date() }))
  })

  it("LeaseTerminationQuote_one_accepted: one accepted termination per lease", async () => {
    await refuses({ index: "LeaseTerminationQuote_one_accepted" }, /Unique constraint/,
      async (tx) => { await accept(tx, (await quote(tx, unbilled)).id); await accept(tx, (await quote(tx, unbilled)).id) })
  })

  it("LeaseRental_guard: a rental is cancelled only inside the termination's flag, on a QUOTED quote", async () => {
    // The quote is accepted in the same transaction, so the deferred LeaseRental_cancelled_by_acceptance is satisfied:
    // without the flag only the immediate guard refuses.
    await refuses({ table: "LeaseRental", trigger: "LeaseRental_guard" }, /only by an accepted early termination/, async (tx) => {
      await accept(tx, (await quote(tx, unbilled)).id)
      const rental = await tx.leaseRental.findFirstOrThrow({ where: { loanId: loans.running, periodNo: 10 } })
      await tx.leaseRental.update({ where: { id: rental.id }, data: { cancelledAt: new Date() } })
      await tx.repaymentSchedule.update({ where: { id: rental.scheduleId }, data: { principalDue: 0, totalDue: 0 } })
    })
  })

  it("LeaseRental_guard: after booking, a rental is written only on a month-to-month extension", async () => {
    await refuses({ table: "LeaseRental", trigger: "LeaseRental_guard" }, /one at a time on a month-to-month extension/, async (tx) => {
      const last = await tx.leaseRental.findFirstOrThrow({ where: { loanId: loans.expired }, orderBy: { periodNo: "desc" } })
      const dueDate = addMonthsClamped(isoOfDbDate(last.dueDate), 1)
      const row = await tx.repaymentSchedule.create({
        data: {
          tenantId: fx.tenantId, loanId: loans.expired, installmentNo: last.periodNo + 1, dueDate: dueDateInstant(dueDate),
          principalDue: last.totalCents, interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue: last.totalCents, status: "PENDING",
        },
      })
      await tx.leaseRental.create({
        data: {
          tenantId: fx.tenantId, loanId: loans.expired, scheduleId: row.id, periodNo: last.periodNo + 1, dueDate: dbDate(dueDate),
          rentalExclVatCents: last.rentalExclVatCents, maintenanceExclVatCents: 0, vatCents: last.vatCents, totalCents: last.totalCents, vatRate: last.vatRate,
        },
      })
    })
  })

  it("the real end-of-term billing path links its own charge row", async () => {
    expect(await attempt(database(), (tx) => chargedReturn(tx))).toBe("ok")
  })

  it("LeaseEndOfTerm_charge_row: an end of term never bills through a rental's row", async () => {
    await refuses({ table: "LeaseEndOfTerm", trigger: "LeaseEndOfTerm_charge_row" }, /lease charge row is a schedule row of its own loan/,
      async (tx) => {
        const id = await inspected(tx)
        const invoice = await invoiceReturn(tx)
        const rental = await tx.leaseRental.findFirstOrThrow({ where: { loanId: loans.expired, periodNo: 1 } })
        await tx.leaseEndOfTerm.update({ where: { id }, data: { status: "INVOICED", taxInvoiceId: invoice.id, scheduleId: rental.scheduleId } })
      })
  })

  it("RepaymentSchedule_lease_charge_total: a charge row's total stays its invoice's", async () => {
    await refuses({ table: "RepaymentSchedule", trigger: "RepaymentSchedule_lease_charge_total" }, /charge row's total due is its tax invoice's total/, async (tx) => {
      const rowId = await chargedReturn(tx)
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE") // the link is checked; then the row is adjusted
      await tx.repaymentSchedule.update({ where: { id: rowId }, data: { principalDue: { increment: 1 }, totalDue: { increment: 1 } } })
    })
  })
})
