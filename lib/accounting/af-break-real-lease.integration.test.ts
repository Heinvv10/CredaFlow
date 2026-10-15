/**
 * BREAK item 7 on REAL booked leases (RUN_ACCOUNTING_IT): a full-maintenance lease and an operating lease booked through the real deal,
 * payout and booking routes, rentals invoiced by the real invoice batch, credit notes issued by the real issuer (before and after a
 * write-off and in full), receipts through the real receipt path, a write-off through the real route. Every month closes with every
 * tie and control nil, BANK agrees with the tables, and the receivable of the written-off lease is nil.
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { issueCreditNote } from "@/lib/vat/credit-note"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { backdateLease } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import { cleanupDealFixture } from "@/lib/asset-finance/deal.integration-fixture"
import { runLeaseInvoiceBatch } from "@/lib/asset-finance/lease-invoice-batch"
import { approveLease, cleanupLeaseRows, createLeaseFixture, leaseBody, payoutAndBook, signLease, type LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import { addMonthsClamped } from "@/lib/asset-finance/dates"
import { e2eRoutes } from "@/lib/asset-finance/recovery-e2e.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { ASSET_FINANCE_ROLES } from "./accounts"
import { expectedBank } from "./af-break.fixture"
import { AccountingPeriodError, closePeriod } from "./generate"
import { parsePeriodKey } from "./period"
import { planPeriod } from "./plan"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ACCOUNTING_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : (null as unknown as PrismaClient)
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let fml = ""
let op = ""
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@lease-acct.test`, role, tenantId: fx.tenantId })
const today = () => sastCalendarDate(new Date())
const FUTURE = new Date("2028-02-05T10:00:00+02:00")
const MONTHS = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12", "2028-01"]
const plan = (key: string) => runWithTenant(fx.tenantId, () => planPeriod(prisma, fx.tenantId, parsePeriodKey(key)!, FUTURE))
const close = (key: string) => runWithTenant(fx.tenantId, () => closePeriod(prisma, { tenantId: fx.tenantId, periodKey: key, userId: fx.adminA, userEmail: "lease@test.invalid", now: FUTURE }))

async function closeThrough(last: string) {
  const out: Array<{ key: string; closed: boolean; code?: string; message?: string }> = []
  for (const key of MONTHS) {
    if (key > last) break
    if (await db.accountingExportBatch.count({ where: { tenantId: fx.tenantId, periodKey: key } })) continue
    try { await close(key); out.push({ key, closed: true }) } catch (e) {
      if (!(e instanceof AccountingPeriodError)) throw e
      out.push({ key, closed: false, code: e.code, message: e.message })
      break
    }
  }
  return out
}
const roleTotals = async () => {
  const rows = await db.$queryRaw<Array<{ role: string; cents: bigint }>>`
    SELECT COALESCE(l."sourceRole", l."role") AS role, SUM(l."debitCents" - l."creditCents")::bigint AS cents
    FROM "AccountingJournalLine" l JOIN "AccountingExportBatch" b ON b."id" = l."batchId"
    WHERE l."tenantId" = ${fx.tenantId} AND b."status" = 'CLOSED' GROUP BY 1`
  return Object.fromEntries(rows.map((r) => [r.role, Number(r.cents)])) as Record<string, number>
}
const invoicesOf = (loanId: string) => db.taxInvoice.findMany({ where: { loanId }, orderBy: { number: "asc" } })
const credit = (invoiceId: string, issueDate: string, excl: number) =>
  prisma.$transaction((tx) => issueCreditNote(tx as never, { tenantId: fx.tenantId, invoiceId, issueDate, reason: "Synthetic credit", exclVatCents: excl, createdById: fx.adminA }))

suite.sequential("real leases through the accounting close", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createLeaseFixture(db, t)
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { requireStaffTotp: false, bureauReportingStartDate: new Date("2020-01-01T00:00:00Z") } })
    const book = async (body: Parameters<typeof leaseBody>[1], start?: string) => {
      const dealId = await approveLease(fx, staff, leaseBody(fx, body))
      await signLease(fx, db, setSession, dealId, start)
      return payoutAndBook(fx, db, staff, dealId)
    }
    fml = await book({ assetId: fx.assets[0], contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced })
    const firstDue = addMonthsClamped(today(), 1)
    op = await book({ assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ADVANCE", clientId: fx.lessee, rateBasis: "FIXED", rateMargin: undefined, fixedRate: "0.135", firstDueDate: firstDue }, firstDue)
    await backdateLease(db, fml, 3)
    await backdateLease(db, op, 1)
    expect((await runLeaseInvoiceBatch(db as never, today())).ok).toBe(true)
    await db.accountingSettings.create({ data: { tenantId: fx.tenantId, mappingConfirmedAt: new Date(), mappingConfirmedRoles: [...ASSET_FINANCE_ROLES], goLiveMonth: today().slice(0, 7) } })
  }, 600_000)
  afterAll(async () => {
    session.current = null
    await db.$transaction([db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.accountingJournalLine.deleteMany({ where: { tenantId: fx.tenantId } }), db.accountingLedgerEntry.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.accountingOpeningPosition.deleteMany({ where: { tenantId: fx.tenantId } }), db.accountingExportBatch.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.accountingSettings.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.creditNote.deleteMany({ where: { tenantId: fx.tenantId } })]).catch(() => undefined)
    await db.$transaction([db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.documentAccessLog.deleteMany({ where: { documentId: { in: (await db.taxInvoice.findMany({ where: { tenantId: fx.tenantId }, select: { id: true } })).map((i) => i.id) } } }),
      db.taxInvoiceLine.deleteMany({ where: { invoice: { tenantId: fx.tenantId } } }), db.taxInvoice.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.maintenanceFundMovement.deleteMany({ where: { tenantId: fx.tenantId } }), db.maintenanceFund.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.assetMeterReading.deleteMany({ where: { tenantId: fx.tenantId } }), db.leaseEndOfTerm.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.payout.deleteMany({ where: { tenantId: fx.tenantId } }), db.payoutChecklistItem.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.contractRate.deleteMany({ where: { tenantId: fx.tenantId } }), db.payment.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.repaymentSchedule.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.assetFinanceDeal.updateMany({ where: { tenantId: fx.tenantId }, data: { loanId: null } }), db.loan.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.supplierBankAccount.deleteMany({ where: { tenantId: fx.tenantId } }), db.vatConfig.deleteMany({ where: { tenantId: fx.tenantId } })]).catch(() => undefined)
    await cleanupLeaseRows(db, fx.tenantId).catch(() => undefined)
    await cleanupDealFixture(db, fx).catch(() => undefined)
    await db.$disconnect()
  }, 600_000)

  it("L1. the booking month closes with the back-dated rentals posted by origin, every control nil", async () => {
    const out = await closeThrough(today().slice(0, 7))
    expect(out, JSON.stringify(out)).toEqual([{ key: today().slice(0, 7), closed: true }])
    const rentals = await db.leaseRental.findMany({ where: { loanId: { in: [fml, op] }, taxInvoiceId: { not: null } } })
    expect(rentals.length).toBeGreaterThan(0)
  }, 300_000)

  it("L2. credit notes (partial, then the rest of a rental, on two leases) post once, in the next open month, and the tie holds", async () => {
    const [fmlInv] = await invoicesOf(fml)
    const [opInv] = await invoicesOf(op)
    await credit(fmlInv.id, today(), 10_000)
    await credit(fmlInv.id, today(), fmlInv.totalExclVatCents - 10_000) // the rest: a full credit
    if (opInv) await credit(opInv.id, today(), 5_000)
    const out = await closeThrough("2026-12")
    expect(out.filter((o) => !o.closed), JSON.stringify(out)).toEqual([])
    const again = await plan("2027-01")
    expect(again.entries.filter((e) => e.eventType === "CREDIT_NOTE"), "credit notes posted again").toEqual([])
    expect(again.controls).toEqual([])
  }, 600_000)

  it("L3. a real receipt on the operating lease (invoices its next rental on receipt) and a reconciling month", async () => {
    staff(fx.adminA, "LOAN_ADMIN")
    const payDb = { $transaction: (run: (c: unknown) => Promise<unknown>) => prisma.$transaction(run as never) } as unknown as PaymentDb
    await runWithTenant(fx.tenantId, () => applyManualReceipt(payDb, {
      loanId: op, tenantId: fx.tenantId, amount: 100_000, paymentMethod: "EFT", reference: "LEASE-REAL-1", notes: "synthetic", capturedById: fx.adminA,
      idempotencyKey: `lease-real-1-${t}`, receivedAt: new Date(),
    }))
    const out = await closeThrough("2027-03")
    expect(out.filter((o) => !o.closed), JSON.stringify(out)).toEqual([])
  }, 600_000)

  it("L4. the full-maintenance lease is written off through the real route, then a credit note is issued on its invoice AFTER the write-off", async () => {
    const wo = e2eRoutes(fx.host)
    staff(fx.adminA, "LOAN_ADMIN")
    const req = await wo.writeOff(fml, { action: "request", reason: "Lease abandoned (synthetic)" })
    expect(req.status, JSON.stringify(req.body)).toBe(200)
    staff(fx.adminB, "LOAN_ADMIN")
    expect((await wo.writeOff(fml, { action: "approve", confirm: true })).status).toBe(200)
    expect((await db.loan.findUniqueOrThrow({ where: { id: fml } })).status).toBe("WRITTEN_OFF")
    const out1 = await closeThrough("2027-04")
    expect(out1.filter((o) => !o.closed), JSON.stringify(out1)).toEqual([])
    const invs = await invoicesOf(fml)
    const target = invs[invs.length - 1]
    await credit(target.id, today(), 1_000)
    const out2 = await closeThrough("2027-06")
    expect(out2.filter((o) => !o.closed), JSON.stringify(out2)).toEqual([])
    const rows = await db.$queryRaw<Array<{ cents: bigint }>>`
      SELECT SUM(l."debitCents" - l."creditCents")::bigint AS cents FROM "AccountingJournalLine" l JOIN "AccountingLedgerEntry" e ON e."id" = l."entryId"
      JOIN "AccountingExportBatch" b ON b."id" = l."batchId" WHERE e."loanId" = ${fml} AND COALESCE(l."sourceRole", l."role") = 'LEASE_DEBTORS' AND b."status" = 'CLOSED'`
    const opening = await db.accountingOpeningPosition.aggregate({ where: { tenantId: fx.tenantId, loanId: fml, role: "LEASE_DEBTORS" }, _sum: { cents: true } })
    const receivable = Number(rows[0].cents ?? 0) + Number(opening._sum.cents ?? 0)
    expect(receivable, "receivable of a written-off lease (entries + opening positions)").toBe(0)
  }, 600_000)

  it("L5. BANK in the ledger equals the tables; nothing was posted twice", async () => {
    const tt = await roleTotals()
    const bank = await expectedBank(fx.tenantId, new Date("2027-07-01T00:00:00+02:00"), new Date("2026-09-30T22:00:00Z"))
    expect(tt.BANK, `ledger ${tt.BANK} vs tables ${bank}`).toBe(bank)
    const dupes = await db.accountingLedgerEntry.groupBy({ by: ["eventKey"], where: { tenantId: fx.tenantId }, _count: true, having: { eventKey: { _count: { gt: 1 } } } })
    expect(dupes).toEqual([])
  }, 300_000)
})
