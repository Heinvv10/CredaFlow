/**
 * Real-Postgres proof of the accounting export: periods close balanced and
 * once, re-export is byte-identical, closed periods are immutable, and the
 * database itself refuses an unbalanced or unclosed batch.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/accounting.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// The tie-out's independent figure, skewed on demand to prove a close is refused.
const skew = vi.hoisted(() => ({ cents: 0 }))
vi.mock("./reconcile", async (importOriginal) => {
  const real = await importOriginal<typeof import("./reconcile")>()
  return {
    ...real,
    independentBook: async (...args: Parameters<typeof real.independentBook>) => {
      const book = await real.independentBook(...args)
      if (skew.cents) for (const v of book.values()) v.cents += skew.cents
      return book
    },
  }
})
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { renderCsv } from "./csv"
import { AccountingPeriodError, closePeriod } from "./generate"
import { loadBatchLines } from "./store"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const AFTER = new Date("2026-11-05T10:00:00+02:00")
let ids: { tenantId: string; userId: string; loanId: string }
let paymentId: string

const close = (periodKey: string) => runWithTenant(ids.tenantId, () =>
  closePeriod(prisma, { tenantId: ids.tenantId, periodKey, userId: ids.userId, userEmail: "acct-it@test.invalid", now: AFTER }))
const csv = (batchId: string) => runWithTenant(ids.tenantId, async () => renderCsv("generic", (await loadBatchLines(prisma, ids.tenantId, batchId))!))
const entries = (batchId: string) => db.accountingLedgerEntry.findMany({ where: { batchId }, include: { lines: true }, orderBy: { eventKey: "asc" } })

async function refused(work: Promise<unknown>, message: RegExp) {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error, "expected the database to refuse").not.toBeNull()
  expect(String((error as Error).message)).toMatch(message)
}

suite.sequential("accounting export (real Postgres)", () => {
  beforeAll(async () => {
    ids = await createChargesLoan(db, await createChargesTenant(db, false))
    const payment = await db.payment.create({
      data: { tenantId: ids.tenantId, loanId: ids.loanId, amount: 50_000, receivedAt: new Date("2026-09-10T10:00:00+02:00") },
    })
    paymentId = payment.id
  })
  afterAll(async () => { await db.$disconnect() })

  it("refuses the first close until the mapping is confirmed and the go-live month is set, and starts at go-live", async () => {
    await expect(close("2026-08")).rejects.toMatchObject({ code: "MAPPING_NOT_CONFIRMED" })
    await db.accountingSettings.create({ data: { tenantId: ids.tenantId, mappingConfirmedAt: new Date() } })
    await expect(close("2026-08")).rejects.toMatchObject({ code: "GO_LIVE_NOT_SET" })
    await db.accountingSettings.update({ where: { tenantId: ids.tenantId }, data: { goLiveMonth: "2026-08" } })
    await expect(close("2026-09")).rejects.toMatchObject({ code: "OUT_OF_ORDER" })
  })

  it("refuses a close whose journal loan book does not tie to what borrowers owe", async () => {
    skew.cents = 100
    try {
      await expect(close("2026-08")).rejects.toMatchObject({ code: "RECONCILIATION_FAILED" })
    } finally {
      skew.cents = 0
    }
    expect(await db.accountingExportBatch.count({ where: { tenantId: ids.tenantId } })).toBe(0)
  })

  it("closes the first month with everything to its end, balanced and sealed", async () => {
    const out = await close("2026-08")
    expect(out.created).toBe(true)
    const batch = await db.accountingExportBatch.findUniqueOrThrow({ where: { id: out.batchId } })
    expect(batch).toMatchObject({ status: "CLOSED", entryCount: 1, lineCount: 2 })
    expect(batch.totalDebitCents).toBe(BigInt(200_000))
    expect(batch.totalCreditCents).toBe(batch.totalDebitCents)
    const [entry] = await entries(out.batchId)
    expect(entry).toMatchObject({ eventKey: `loan:${ids.loanId}:disbursement`, eventType: "DISBURSEMENT", postingDate: "2026-08-01" })
    const audit = await db.auditLog.findFirst({ where: { entityId: out.batchId, action: "ACCOUNTING_PERIOD_CLOSED" } })
    expect(audit).not.toBeNull()
  })

  it("returns the same batch when asked again, and the same CSV bytes every time", async () => {
    const first = await close("2026-08")
    const again = await close("2026-08")
    expect(again).toEqual({ batchId: first.batchId, created: false })
    expect(await csv(first.batchId)).toBe(await csv(again.batchId))
    expect(await db.accountingExportBatch.count({ where: { tenantId: ids.tenantId } })).toBe(1)
  })

  it("refuses to skip a month, and refuses a month that has not ended", async () => {
    await expect(close("2026-10")).rejects.toMatchObject({ code: "OUT_OF_ORDER" })
    await expect(runWithTenant(ids.tenantId, () => closePeriod(prisma, {
      tenantId: ids.tenantId, periodKey: "2026-09", userId: ids.userId, userEmail: "x@test.invalid", now: new Date("2026-09-20T00:00:00Z"),
    }))).rejects.toBeInstanceOf(AccountingPeriodError)
  })

  it("posts the next month's instalment and receipt, each event once", async () => {
    const sep = await close("2026-09")
    const rows = await entries(sep.batchId)
    expect(rows.map((r) => r.eventType).sort()).toEqual(["INSTALMENT_DUE", "RECEIPT"])
    const receipt = rows.find((r) => r.eventType === "RECEIPT")!
    expect(receipt.eventKey).toBe(`payment:${paymentId}`)
    expect(receipt.lines.map((l) => [l.role, l.debitCents, l.creditCents])).toEqual([["BANK", 50_000, 0], ["LOAN_BOOK", 0, 50_000]])
  })

  it("reverses a receipt in the month it was reversed, under a new event key", async () => {
    await db.payment.update({ where: { id: paymentId }, data: { reversed: true, reversedAt: new Date("2026-10-03T09:00:00+02:00"), reversalReason: "Bounced" } })
    const oct = await close("2026-10")
    const [reversal] = (await entries(oct.batchId)).filter((r) => r.eventType === "REVERSAL")
    expect(reversal).toMatchObject({ eventKey: `payment:${paymentId}@2026-10`, postingDate: "2026-10-03" })
    expect(await db.accountingLedgerEntry.count({ where: { tenantId: ids.tenantId, eventKey: `payment:${paymentId}` } })).toBe(1)
  })

  it("keeps closed periods immutable", async () => {
    const batch = await db.accountingExportBatch.findFirstOrThrow({ where: { tenantId: ids.tenantId, periodKey: "2026-09" }, include: { lines: true, entries: true } })
    await refused(db.accountingJournalLine.update({ where: { id: batch.lines[0].id }, data: { debitCents: 1 } }), /never changed or deleted/)
    await refused(db.accountingLedgerEntry.delete({ where: { id: batch.entries[0].id } }), /never changed or deleted/)
    await refused(db.accountingExportBatch.update({ where: { id: batch.id }, data: { lineCount: 99 } }), /closed accounting period is immutable/)
    await refused(db.accountingExportBatch.delete({ where: { id: batch.id } }), /never deleted/)
    await refused(db.accountingJournalLine.create({
      data: { tenantId: ids.tenantId, batchId: batch.id, entryId: batch.entries[0].id, lineNo: 999, role: "BANK", accountCode: "1000", debitCents: 1 },
    }), /closed accounting period is immutable/)
  })

  it("refuses, in the database, a batch that does not balance", async () => {
    const tenantId = ids.tenantId
    const unbalanced = db.$transaction(async (tx) => {
      const batchId = randomUUID()
      const entryId = randomUUID()
      await tx.accountingExportBatch.create({ data: { id: batchId, tenantId, periodKey: "2027-01", periodStart: new Date("2026-12-31T22:00:00Z"), periodEnd: new Date("2027-01-31T22:00:00Z"), createdById: ids.userId } })
      await tx.accountingLedgerEntry.create({ data: { id: entryId, tenantId, batchId, eventKey: `forged:${batchId}`, baseKey: "forged", eventType: "ADJUSTMENT", eventDate: new Date(), postingDate: "2027-01-01", reference: "X", description: "forged" } })
      await tx.accountingJournalLine.createMany({ data: [
        { tenantId, batchId, entryId, lineNo: 1, role: "BANK", accountCode: "1000", debitCents: 100 },
        { tenantId, batchId, entryId, lineNo: 2, role: "LOAN_BOOK", accountCode: "1100", creditCents: 90 },
      ] })
      await tx.accountingExportBatch.update({ where: { id: batchId }, data: { status: "CLOSED", closedAt: new Date(), linesSha256: "x", entryCount: 1, lineCount: 2, totalDebitCents: 100, totalCreditCents: 100 } })
    })
    await refused(unbalanced, /journals do not balance/)
  })

  it("refuses, in the database, a batch left open at commit", async () => {
    const tenantId = ids.tenantId
    const open = (periodKey: string, start: string, end: string) => ({ tenantId, periodKey, periodStart: new Date(start), periodEnd: new Date(end), createdById: ids.userId })
    // Surfaced as a statement error once deferred checks run immediately (as closePeriod does).
    await refused(db.$transaction(async (tx) => {
      await tx.accountingExportBatch.create({ data: open("2027-02", "2027-01-31T22:00:00Z", "2027-02-28T22:00:00Z") })
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    }), /closed in the transaction that creates it/)
    // Left to COMMIT, the check still rolls it back (Prisma does not report a
    // commit-time error, which is why closePeriod forces the check early).
    await db.$transaction(async (tx) => {
      await tx.accountingExportBatch.create({ data: open("2027-04", "2027-03-31T22:00:00Z", "2027-04-30T22:00:00Z") })
    }).catch(() => undefined)
    expect(await db.accountingExportBatch.count({ where: { tenantId, periodKey: { in: ["2027-01", "2027-02", "2027-04"] } } })).toBe(0)
  })

  it("refuses a journal line that is both a debit and a credit", async () => {
    const tenantId = ids.tenantId
    await refused(db.$transaction(async (tx) => {
      const batchId = randomUUID()
      const entryId = randomUUID()
      await tx.accountingExportBatch.create({ data: { id: batchId, tenantId, periodKey: "2027-05", periodStart: new Date("2027-04-30T22:00:00Z"), periodEnd: new Date("2027-05-31T22:00:00Z"), createdById: ids.userId } })
      await tx.accountingLedgerEntry.create({ data: { id: entryId, tenantId, batchId, eventKey: `two-sided:${batchId}`, baseKey: "x", eventType: "ADJUSTMENT", eventDate: new Date(), postingDate: "2027-05-01", reference: "X", description: "x" } })
      await tx.accountingJournalLine.create({ data: { tenantId, batchId, entryId, lineNo: 1, role: "BANK", accountCode: "1000", debitCents: 5, creditCents: 5 } })
    }), /AccountingJournalLine_one_side/)
  })

  it("exports each event once: the ledger refuses a second entry with the same event key", async () => {
    const existing = await db.accountingLedgerEntry.findFirstOrThrow({ where: { tenantId: ids.tenantId, eventType: "DISBURSEMENT" } })
    const duplicate = db.$transaction(async (tx) => {
      const batchId = randomUUID()
      await tx.accountingExportBatch.create({ data: { id: batchId, tenantId: ids.tenantId, periodKey: "2027-03", periodStart: new Date("2027-02-28T22:00:00Z"), periodEnd: new Date("2027-03-31T22:00:00Z"), createdById: ids.userId } })
      await tx.accountingLedgerEntry.create({ data: { tenantId: ids.tenantId, batchId, eventKey: existing.eventKey, baseKey: existing.baseKey, eventType: "DISBURSEMENT", eventDate: new Date(), postingDate: "2027-03-01", reference: "X", description: "again" } })
    })
    await refused(duplicate, /Unique constraint|unique/i)
  })
})
