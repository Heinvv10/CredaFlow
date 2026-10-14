/**
 * Closing an accounting period: derive, prove the balance, store, seal.
 *
 * One transaction under a per-tenant advisory lock: the batch is created OPEN,
 * its entries and lines inserted, and it is closed with its totals and the
 * digest of its lines. The database re-proves the balance at close and
 * refuses to commit a batch left open (guardAccountingBatch,
 * requireAccountingBatchClosedAtCommit). Asking for a month that is already
 * closed returns it unchanged.
 *
 * Months close in order: the first close takes everything up to its end (the
 * opening position); after that only the month following the last closed one
 * may close, so no month is skipped and a late event lands in the next month.
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"
import { linesDigest, type StoredLine } from "./csv"
import { deriveEntries, type DerivedEntry } from "./derive"
import { nextPeriodKey, parsePeriodKey, periodHasEnded, type AccountingPeriod } from "./period"
import { loadAccountMap, loadLedger, loadSourceLoans, type AccountingDb } from "./store"
import { verifyBalanced, type BatchTotals } from "./verify"

export type CloseRefusal = "INVALID_PERIOD" | "PERIOD_NOT_ENDED" | "OUT_OF_ORDER"

export class AccountingPeriodError extends Error {
  constructor(readonly code: CloseRefusal, message: string) {
    super(message)
    this.name = "AccountingPeriodError"
  }
}

type GenerateDb = Pick<typeof prisma, "$transaction">

export function requirePeriod(periodKey: unknown): AccountingPeriod {
  const period = parsePeriodKey(periodKey)
  if (!period) throw new AccountingPeriodError("INVALID_PERIOD", "Period must be a month, yyyy-mm")
  return period
}

/** The entries a period would post now, without writing anything. */
export async function derivePeriod(db: AccountingDb, tenantId: string, period: AccountingPeriod): Promise<{ entries: DerivedEntry[]; totals: BatchTotals }> {
  const [accounts, loans, ledger] = await Promise.all([
    loadAccountMap(db, tenantId),
    loadSourceLoans(db, tenantId, period.end),
    loadLedger(db, tenantId),
  ])
  const entries = deriveEntries({ loans, period, accounts, ...ledger })
  return { entries, totals: verifyBalanced(entries) }
}

export function storedLinesOf(entries: DerivedEntry[]): StoredLine[] {
  let lineNo = 0
  return entries.flatMap((e) => e.lines.map((l) => ({
    lineNo: ++lineNo,
    postingDate: e.postingDate,
    accountCode: l.accountCode,
    taxCode: l.taxCode,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
    reference: e.reference,
    description: e.description,
    eventKey: e.eventKey,
  })))
}

export async function closePeriod(db: GenerateDb, args: {
  tenantId: string
  periodKey: string
  userId: string
  userEmail: string
  now?: Date
}): Promise<{ batchId: string; created: boolean }> {
  const period = requirePeriod(args.periodKey)
  if (!periodHasEnded(period, args.now ?? new Date())) {
    throw new AccountingPeriodError("PERIOD_NOT_ENDED", `${period.label} has not ended; a month closes once it is over`)
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`accounting-export:${args.tenantId}`}))`)
    const existing = await tx.accountingExportBatch.findFirst({ where: { tenantId: args.tenantId, periodKey: period.key }, select: { id: true } })
    if (existing) return { batchId: existing.id, created: false }
    const latest = await tx.accountingExportBatch.findFirst({
      where: { tenantId: args.tenantId },
      orderBy: { periodStart: "desc" },
      select: { periodKey: true },
    })
    if (latest && nextPeriodKey(latest.periodKey) !== period.key) {
      throw new AccountingPeriodError("OUT_OF_ORDER", `The next month to close is ${nextPeriodKey(latest.periodKey)}`)
    }

    const { entries, totals } = await derivePeriod(tx, args.tenantId, period)
    const batchId = randomUUID()
    await tx.accountingExportBatch.create({
      data: { id: batchId, tenantId: args.tenantId, periodKey: period.key, periodStart: period.start, periodEnd: period.end, createdById: args.userId },
    })
    const entryIds = entries.map(() => randomUUID())
    if (entries.length > 0) {
      await tx.accountingLedgerEntry.createMany({
        data: entries.map((e, i) => ({
          id: entryIds[i], tenantId: args.tenantId, batchId, eventKey: e.eventKey, baseKey: e.baseKey, eventType: e.eventType,
          eventDate: e.eventDate, postingDate: e.postingDate, loanId: e.loanId, reference: e.reference, description: e.description,
        })),
      })
      const stored = storedLinesOf(entries)
      let i = 0
      await tx.accountingJournalLine.createMany({
        data: entries.flatMap((e, entryIndex) => e.lines.map((l) => ({
          tenantId: args.tenantId, batchId, entryId: entryIds[entryIndex], lineNo: stored[i++].lineNo,
          role: l.role, accountCode: l.accountCode, taxCode: l.taxCode, debitCents: l.debitCents, creditCents: l.creditCents,
        }))),
      })
    }
    const digest = linesDigest(storedLinesOf(entries))
    await tx.accountingExportBatch.update({
      where: { id: batchId },
      data: {
        status: "CLOSED", closedAt: new Date(), linesSha256: digest,
        entryCount: totals.entryCount, lineCount: totals.lineCount,
        totalDebitCents: totals.debitCents, totalCreditCents: totals.creditCents,
      },
    })
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.userId, userEmail: args.userEmail,
      action: AuditAction.ACCOUNTING_PERIOD_CLOSED, entity: "AccountingExportBatch", entityId: batchId,
      newValue: {
        periodKey: period.key, entryCount: totals.entryCount, lineCount: totals.lineCount,
        totalDebitCents: totals.debitCents.toString(), totalCreditCents: totals.creditCents.toString(), linesSha256: digest,
      },
    }, tx)
    // Run the deferred "closed at commit" check now: Prisma does not report an
    // error raised at COMMIT, so a refusal must surface as a statement error.
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return { batchId, created: true }
  }, { timeout: 120_000, maxWait: 10_000 })
}
