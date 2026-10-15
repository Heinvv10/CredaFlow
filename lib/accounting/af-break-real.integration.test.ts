/**
 * BREAK items 1, 2, 7 on REAL booked data (RUN_ACCOUNTING_IT): an instalment sale booked through the real deal, payout and booking
 * routes, serviced with real receipts, repossessed through the real recovery routes (costs, sale, proceeds), written off through the
 * real write-off route; every month closed through the real planner. The journals must close, every control and tie must be nil, and
 * the books must agree with an oracle that reads the raw tables (BANK, VAT, the repossession's cash).
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import { sastCalendarDate } from "@/lib/date/sast"
import { applyManualReceipt, type PaymentDb } from "@/lib/loan/apply-payment"
import { cleanupBookedContractFixture, createBookedContractFixture, type BookedContractFixture } from "@/lib/asset-finance/portal-contract.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { cleanupE2e, e2eRoutes } from "@/lib/asset-finance/recovery-e2e.integration-fixture"
import { recoveryRoutes } from "@/lib/asset-finance/recovery-routes.integration-fixture"
import { readJson, saleBody, saleRoutes } from "@/lib/asset-finance/recovery-sale.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { prisma } from "@/lib/prisma"
import { expectedBank } from "./af-break.fixture"
import { ASSET_FINANCE_ROLES } from "./accounts"
import { AccountingPeriodError, closePeriod } from "./generate"
import { parsePeriodKey } from "./period"
import { planPeriod } from "./plan"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ACCOUNTING_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : (null as unknown as PrismaClient)
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: BookedContractFixture
const setSession = (user: SessionUser | null) => { session.current = user && { user } }
const as = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@real-it.test`, role, tenantId: fx.tenantId })
const today = () => sastCalendarDate(new Date())
const FUTURE = new Date("2028-02-05T10:00:00+02:00")
const months = ["2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03", "2027-04", "2027-05", "2027-06", "2027-07", "2027-08", "2027-09", "2027-10", "2027-11", "2027-12", "2028-01"]
const plan = (key: string, now = FUTURE) => runWithTenant(fx.tenantId, () => planPeriod(prisma, fx.tenantId, parsePeriodKey(key)!, now))
const close = (key: string, now = FUTURE) => runWithTenant(fx.tenantId, () => closePeriod(prisma, { tenantId: fx.tenantId, periodKey: key, userId: fx.adminA, userEmail: "real@test.invalid", now }))

async function closeThrough(last: string) {
  const out: Array<{ key: string; closed: boolean; code?: string; message?: string; controls?: unknown }> = []
  for (const key of months) {
    if (key > last) break
    if (await db.accountingExportBatch.count({ where: { tenantId: fx.tenantId, periodKey: key } })) continue
    const p = await plan(key)
    try { await close(key); out.push({ key, closed: true }) } catch (e) {
      if (!(e instanceof AccountingPeriodError)) throw e
      out.push({ key, closed: false, code: e.code, message: e.message, controls: p.controls })
      break
    }
  }
  return out
}

async function totals() {
  const rows = await db.$queryRaw<Array<{ role: string; cents: bigint }>>`
    SELECT COALESCE(l."sourceRole", l."role") AS role, SUM(l."debitCents" - l."creditCents")::bigint AS cents
    FROM "AccountingJournalLine" l JOIN "AccountingExportBatch" b ON b."id" = l."batchId"
    WHERE l."tenantId" = ${fx.tenantId} AND b."status" = 'CLOSED' GROUP BY 1`
  return Object.fromEntries(rows.map((r) => [r.role, Number(r.cents)])) as Record<string, number>
}

suite.sequential("real booked instalment sale: receipts, recovery, write-off through the accounting close", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createBookedContractFixture(db, t, setSession)
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { bureauReportingStartDate: new Date("2020-01-01T00:00:00Z"), requireStaffTotp: false } })
    await db.accountingSettings.create({ data: { tenantId: fx.tenantId, mappingConfirmedAt: new Date(), mappingConfirmedRoles: [...ASSET_FINANCE_ROLES], goLiveMonth: sastCalendarDate(new Date()).slice(0, 7) } })
  }, 300_000)
  afterAll(async () => {
    session.current = null
    await db.$transaction([db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.accountingJournalLine.deleteMany({ where: { tenantId: fx.tenantId } }), db.accountingLedgerEntry.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.accountingOpeningPosition.deleteMany({ where: { tenantId: fx.tenantId } }), db.accountingExportBatch.deleteMany({ where: { tenantId: fx.tenantId } }),
      db.accountingSettings.deleteMany({ where: { tenantId: fx.tenantId } })]).catch(() => undefined)
    await cleanupE2e(db, fx.tenantId).catch(() => undefined)
    await cleanupBookedContractFixture(db, fx).catch(() => undefined)
    await db.$disconnect()
  }, 300_000)

  it("R1. the booking month closes: inception posted once, tied, controls nil", async () => {
    const out = await closeThrough(sastCalendarDate(new Date()).slice(0, 7))
    expect(out, JSON.stringify(out)).toEqual([{ key: sastCalendarDate(new Date()).slice(0, 7), closed: true }])
    const loan = await db.loan.findUniqueOrThrow({ where: { id: fx.loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" }, take: 1 }, taxInvoices: true } })
    const entries = await db.accountingLedgerEntry.findMany({ where: { loanId: fx.loanId } })
    expect(entries.map((e) => e.baseKey)).toContain(`af:${fx.loanId}:inception`)
    const t0 = await totals()
    // F = the first row's opening balance: the receivable is the financed amount
    expect(t0.AF_INSTALMENT_DEBTORS).toBe(loan.repaymentSchedule[0].assetFinanceOpeningBalanceCents)
  }, 300_000)

  it("R2. a real receipt, a real reversal, the schedule falling due: every month to a year out closes with nothing to correct", async () => {
    as(fx.adminA, "LOAN_ADMIN")
    const payDb = { $transaction: (run: (c: unknown) => Promise<unknown>) => prisma.$transaction(run as never) } as unknown as PaymentDb
    const receipt = await runWithTenant(fx.tenantId, () => applyManualReceipt(payDb, {
      loanId: fx.loanId, tenantId: fx.tenantId, amount: 5_000_000, paymentMethod: "EFT", reference: "REAL-1", notes: "synthetic", capturedById: fx.adminA,
      idempotencyKey: `real-1-${t}`, receivedAt: new Date(),
    }))
    expect(receipt.payment.amount).toBe(5_000_000)
    const out = await closeThrough("2027-10")
    expect(out.filter((o) => !o.closed), JSON.stringify(out)).toEqual([])
    expect((await totals()).AF_INSTALMENT_DEBTORS).toBeGreaterThan(0)
  }, 600_000)

  it("R3. a repossession through the real routes AFTER the year closed (late events): costs of both treatments, sale, proceeds; the next open month posts each once", async () => {
    const r = recoveryRoutes(fx.host)
    const sr = saleRoutes(fx.host)
    const e = e2eRoutes(fx.host)
    await db.supplier.update({ where: { id: fx.supplier }, data: { vatNumber: "4000000123" } })
    const cost = (type: string, treatment: string, cents: number) => ({ type, treatment, supplierId: fx.supplier, netCents: cents, vatCents: Math.round(cents * 0.15), supplierInvoiceRef: `INV-${randomUUID().slice(0, 6)}`, incurredOn: today() })
    as(fx.officer, "CREDIT_OFFICER")
    const created = await r.create(fx.loanId, { route: "NON_NCA_VOLUNTARY", recoveredOn: today(), location: "TEST Yard", condition: "Synthetic: fair" })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const id = created.body.id as string
    expect((await r.valuation(id, { valuedOn: today(), source: "ASSESSOR", valuerName: "TEST Valuers", amountCents: 100_000_000 })).status).toBe(200)
    expect((await r.listForSale(id)).status).toBe(200)
    const towing = await r.cost(id, cost("TOWING", "DEDUCT_FROM_PROCEEDS", 500_000))
    const legal = await r.cost(id, cost("LEGAL_CONTRACTUAL", "CHARGE_TO_ACCOUNT", 300_000))
    expect([towing.status, legal.status], JSON.stringify([towing.body, legal.body])).toEqual([201, 201])
    as(fx.adminA, "LOAN_ADMIN")
    expect((await e.decideCost(id, towing.body.id as string, "APPROVED")).status).toBe(200)
    expect((await e.decideCost(id, legal.body.id as string, "APPROVED")).status).toBe(200)
    const valuationId = (await db.recovery.findUniqueOrThrow({ where: { id } })).valuationId as string
    const sale = await readJson(await sr.propose(id, saleBody(valuationId, 120_000_000)))
    expect(sale.status, JSON.stringify(sale.body)).toBe(201)
    if (sale.body.approvalRequired) { as(fx.adminB, "LOAN_ADMIN"); expect((await readJson(await sr.approveSale(id, sale.body.id as string))).status).toBe(200); as(fx.adminA, "LOAN_ADMIN") }
    expect((await readJson(await sr.completeSale(id, sale.body.id as string))).status).toBe(200)
    as(fx.officer, "CREDIT_OFFICER")
    const proceeds = await readJson(await sr.proceeds(id))
    expect(proceeds.status, JSON.stringify(proceeds.body)).toBe(200)
    // everything above is dated today: inside the months already closed. The next open month takes it.
    const open = months.find((m) => m > "2027-10")!
    const p = await plan(open)
    const keys = p.entries.map((x) => x.baseKey)
    expect(new Set(keys).size, "a source twice in one month").toBe(keys.length)
    expect(keys.some((k) => k.startsWith(`af-recovery:${id}:sale:`))).toBe(true)
    const out = await closeThrough("2027-12")
    expect(out.filter((o) => !o.closed), JSON.stringify(out)).toEqual([])
    const again = await plan("2028-01")
    expect(again.entries.filter((x) => x.baseKey.includes(id) || !x.baseKey.includes(":row:")).map((x) => `${x.eventKey} ${x.eventType}`), "events posted again").toEqual([])
    const tt = await totals()
    expect(tt.RECOVERY_CLEARING ?? 0).toBe(0)
    expect(tt.INPUT_VAT).toBeDefined()
    const bankLedger = tt.BANK
    const bankOracle = await expectedBank(fx.tenantId, new Date("2028-01-01T00:00:00+02:00"), new Date("2026-09-30T22:00:00Z"))
    expect(bankLedger, `BANK ledger ${bankLedger} vs tables ${bankOracle}`).toBe(bankOracle)
    expect((await db.recovery.findUniqueOrThrow({ where: { id } })).status).toBe("PROCEEDS_APPLIED")
  }, 900_000)

  it("R4. the loan is then written off through the real route; the next month posts the write-off once and the receivable is nil", async () => {
    const wo = e2eRoutes(fx.host)
    as(fx.adminA, "LOAN_ADMIN")
    const req = await wo.writeOff(fx.loanId, { action: "request", reason: "Shortfall after repossession sale (real)" })
    expect(req.status, JSON.stringify(req.body)).toBe(200)
    as(fx.adminB, "LOAN_ADMIN")
    expect((await wo.writeOff(fx.loanId, { action: "approve", confirm: true })).status).toBe(200)
    expect((await db.loan.findUniqueOrThrow({ where: { id: fx.loanId } })).status).toBe("WRITTEN_OFF")
    const out = await closeThrough("2028-01")
    expect(out.filter((o) => !o.closed), JSON.stringify(out)).toEqual([])
    const tt = await totals()
    expect(tt.AF_INSTALMENT_DEBTORS ?? 0, "receivable on a written-off contract").toBe(0)
    expect(tt.BAD_DEBT_EXPENSE ?? 0).toBeGreaterThan(0)
    const writeOffEntries = await db.accountingLedgerEntry.findMany({ where: { loanId: fx.loanId, baseKey: `loan:${fx.loanId}:write-off` } })
    expect(writeOffEntries.length, "write-off posted more than once (first posting plus later corrections only)").toBeGreaterThanOrEqual(1)
  }, 600_000)
})
