/**
 * Closing an accounting period: plan, refuse or prove, store, seal.
 *
 * One REPEATABLE READ transaction under a per-tenant advisory lock, so the
 * derivation reads one snapshot of the loans and the ledger. The batch is
 * created OPEN, its opening positions, entries and lines inserted, and it is
 * closed with its totals and the digest of its lines. The database re-proves
 * the balance at close and refuses to commit a batch left open. Asking for a
 * month that is already closed returns it unchanged. lib/accounting/plan.ts
 * decides whether the month may close (ended, mapping confirmed, in order,
 * loan book ties).
 */
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"
import { linesDigest, type StoredLine } from "./csv"
import type { DerivedEntry } from "./derive"
import { AccountingPeriodError, planPeriod, requirePeriod } from "./plan"

export { AccountingPeriodError, requirePeriod } from "./plan"
export type { CloseRefusal } from "./plan"

type GenerateDb = Pick<typeof prisma, "$transaction" | "accountingExportBatch">

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
  const existingOf = () => db.accountingExportBatch.findFirst({ where: { tenantId: args.tenantId, periodKey: period.key }, select: { id: true } })
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`accounting-export:${args.tenantId}`}))`)
      const existing = await tx.accountingExportBatch.findFirst({ where: { tenantId: args.tenantId, periodKey: period.key }, select: { id: true } })
      if (existing) return { batchId: existing.id, created: false }
      const plan = await planPeriod(tx, args.tenantId, period, args.now ?? new Date())
      if (plan.refusal) throw new AccountingPeriodError(plan.refusal.code, plan.refusal.message)
      const { entries, totals, positions } = plan

      const batchId = randomUUID()
      await tx.accountingExportBatch.create({
        data: { id: batchId, tenantId: args.tenantId, periodKey: period.key, periodStart: period.start, periodEnd: period.end, createdById: args.userId },
      })
      if (positions.length > 0) {
        await tx.accountingOpeningPosition.createMany({
          data: positions.map((p) => ({ tenantId: args.tenantId, batchId, baseKey: p.baseKey, loanId: p.loanId, reference: p.reference, role: p.role, cents: p.cents })),
        })
      }
      const entryIds = entries.map(() => randomUUID())
      const stored = storedLinesOf(entries)
      if (entries.length > 0) {
        await tx.accountingLedgerEntry.createMany({
          data: entries.map((e, i) => ({
            id: entryIds[i], tenantId: args.tenantId, batchId, eventKey: e.eventKey, baseKey: e.baseKey, eventType: e.eventType,
            eventDate: e.eventDate, postingDate: e.postingDate, loanId: e.loanId, reference: e.reference, description: e.description,
          })),
        })
        let i = 0
        await tx.accountingJournalLine.createMany({
          data: entries.flatMap((e, entryIndex) => e.lines.map((l) => ({
            tenantId: args.tenantId, batchId, entryId: entryIds[entryIndex], lineNo: stored[i++].lineNo,
            role: l.role, sourceRole: l.sourceRole, accountCode: l.accountCode, taxCode: l.taxCode, debitCents: l.debitCents, creditCents: l.creditCents,
          }))),
        })
      }
      const digest = linesDigest(stored)
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
          periodKey: period.key, goLive: plan.isGoLive, openingPositions: positions.length,
          entryCount: totals.entryCount, lineCount: totals.lineCount,
          totalDebitCents: totals.debitCents.toString(), totalCreditCents: totals.creditCents.toString(), linesSha256: digest,
          loanBookCents: plan.reconciliation.journalTotalCents,
        },
      }, tx)
      // Run the deferred "closed at commit" check now: Prisma does not report an
      // error raised at COMMIT, so a refusal must surface as a statement error.
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return { batchId, created: true }
    }, { timeout: 120_000, maxWait: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead })
  } catch (error) {
    // A concurrent close of the same month won (its snapshot predates ours):
    // that month is closed, which is what was asked for.
    if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2002" || error.code === "P2034")) {
      const won = await existingOf()
      if (won) return { batchId: won.id, created: false }
    }
    throw error
  }
}
