/**
 * Reads for the accounting export: the money sources, the ledger so far, the
 * tenant's account map, and a closed batch's lines.
 *
 * The accounting tables are NOT in TENANT_SCOPED_MODELS: every query here
 * names its tenant by hand. Loans, payments and schedules are scoped, so
 * callers run inside the tenant's context.
 */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { sastDayStart } from "@/lib/date/sast-period"
import { resolveAccountMap, type AccountMap } from "./accounts"
import { linesDigest, type StoredLine } from "./csv"
import type { PostedLedger } from "./derive"
import type { SourceLoan, Vector } from "./sources"
import type { AccountRole } from "./accounts"

/** Any client that can run these reads: the app's extended client or a transaction. */
export type AccountingDb = Pick<
  typeof prisma,
  "loan" | "accountingAccountMapping" | "accountingExportBatch" | "accountingLedgerEntry" | "accountingJournalLine" | "$queryRaw"
>

export class BatchIntegrityError extends Error {
  constructor(batchId: string) {
    super(`Accounting batch ${batchId} no longer matches the digest it was closed with`)
    this.name = "BatchIntegrityError"
  }
}

export async function loadAccountMap(db: AccountingDb, tenantId: string): Promise<AccountMap> {
  const rows = await db.accountingAccountMapping.findMany({
    where: { tenantId },
    select: { role: true, accountCode: true, accountName: true, taxCode: true },
  })
  return resolveAccountMap(rows)
}

/** Consumer loans (contractType LOAN) booked before `asOf`, with every money source. */
export async function loadSourceLoans(db: AccountingDb, tenantId: string, asOf: Date): Promise<SourceLoan[]> {
  const loans = await db.loan.findMany({
    where: { tenantId, contractType: "LOAN", startDate: { lt: asOf } },
    orderBy: { id: "asc" },
    select: {
      id: true, reference: true, principal: true, initiationFee: true, startDate: true,
      status: true, writeOffAt: true, closedAt: true,
      application: { select: { initiationFeePayment: true } },
      repaymentSchedule: {
        orderBy: { installmentNo: "asc" },
        select: { id: true, installmentNo: true, dueDate: true, interestDue: true, feesDue: true, creditLifePremiumDue: true },
      },
      charges: { orderBy: [{ day: "asc" }, { type: "asc" }], select: { type: true, day: true, amount: true, sourceId: true } },
      payments: {
        orderBy: { id: "asc" },
        select: {
          id: true, amount: true, paymentMethod: true, receivedAt: true, allocationStatus: true,
          reconciledAt: true, reversed: true, reversedAt: true,
        },
      },
    },
  })
  return loans.map((loan) => {
    // A LoanCharge `day` is a calendar date; the same type, day and source
    // is one charge, summed if the re-derivation ever split it.
    const charges = new Map<string, SourceLoan["charges"][number]>()
    for (const c of loan.charges) {
      const day = sastDayStart(c.day.toISOString().slice(0, 10))
      const key = `${c.type}|${day.toISOString()}|${c.sourceId ?? ""}`
      const prior = charges.get(key)
      charges.set(key, { type: c.type, day, amount: (prior?.amount ?? 0) + c.amount, sourceId: c.sourceId })
    }
    return {
      id: loan.id,
      reference: loan.reference,
      principal: loan.principal,
      initiationFee: loan.initiationFee,
      upfrontFee: loan.application.initiationFeePayment === "UPFRONT",
      startDate: loan.startDate,
      status: loan.status,
      writeOffAt: loan.writeOffAt,
      closedAt: loan.closedAt,
      schedule: loan.repaymentSchedule,
      charges: [...charges.values()],
      payments: loan.payments,
    }
  })
}

export interface Ledger {
  posted: PostedLedger
  postedKeys: Set<string>
  postedLoans: Map<string, { loanId: string | null; reference: string }>
}

export async function loadLedger(db: AccountingDb, tenantId: string): Promise<Ledger> {
  const rows = await db.$queryRaw<Array<{ baseKey: string; loanId: string | null; reference: string; role: string; net: bigint }>>(Prisma.sql`
    SELECT e."baseKey", e."loanId", e."reference", l."role", SUM(l."debitCents" - l."creditCents")::bigint AS "net"
    FROM "AccountingJournalLine" l
    JOIN "AccountingLedgerEntry" e ON e."id" = l."entryId" AND e."tenantId" = l."tenantId"
    WHERE e."tenantId" = ${tenantId}
    GROUP BY e."baseKey", e."loanId", e."reference", l."role"
  `)
  const ledger: Ledger = { posted: new Map(), postedKeys: new Set(), postedLoans: new Map() }
  for (const row of rows) {
    ledger.postedKeys.add(row.baseKey)
    ledger.postedLoans.set(row.baseKey, { loanId: row.loanId, reference: row.reference })
    const vector: Vector = ledger.posted.get(row.baseKey) ?? {}
    const net = Number(row.net)
    if (net !== 0) vector[row.role as AccountRole] = net
    ledger.posted.set(row.baseKey, vector)
  }
  return ledger
}

/** A closed batch's lines in order, refused if they no longer match the digest sealed at close. */
export async function loadBatchLines(db: AccountingDb, tenantId: string, batchId: string): Promise<StoredLine[] | null> {
  const batch = await db.accountingExportBatch.findFirst({
    where: { id: batchId, tenantId, status: "CLOSED" },
    select: { id: true, linesSha256: true },
  })
  if (!batch) return null
  const lines = await db.accountingJournalLine.findMany({
    where: { tenantId, batchId },
    orderBy: { lineNo: "asc" },
    select: {
      lineNo: true, accountCode: true, taxCode: true, debitCents: true, creditCents: true,
      entry: { select: { postingDate: true, reference: true, description: true, eventKey: true } },
    },
  })
  const stored = lines.map((l) => ({
    lineNo: l.lineNo,
    postingDate: l.entry.postingDate,
    accountCode: l.accountCode,
    taxCode: l.taxCode,
    debitCents: l.debitCents,
    creditCents: l.creditCents,
    reference: l.entry.reference,
    description: l.entry.description,
    eventKey: l.entry.eventKey,
  }))
  if (linesDigest(stored) !== batch.linesSha256) throw new BatchIntegrityError(batchId)
  return stored
}
