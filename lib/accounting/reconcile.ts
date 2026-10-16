/**
 * The tie-out control a period must pass before it closes: per loan, the
 * journal's loan-book balance after this period equals what the borrower owes
 * to date, computed independently in SQL from the loan tables.
 *
 * "Owed to date" (contract-to-date receivable): principal, plus the interest,
 * fees and premiums of instalments due (an early-settled loan's on the day it
 * closed), plus default charges, less applied receipts (a status reconciled
 * after the period counts as it stood), nothing after a write-off (a
 * written-off loan owes nothing on the book) or an approved disbursement
 * reversal. It is written here a second time, deliberately not through
 * lib/accounting/sources.ts, so a fault in the derivation or the ledger shows
 * up as a difference instead of agreeing with itself.
 *
 * lib/reports/book-as-of.ts is the outstanding PRINCIPAL; the journal holds
 * the whole receivable, so that report is not the comparator.
 */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { RECEIVABLE_ROLES } from "./accounts"
import type { DerivedEntry, PostedLedger } from "./derive"
import { independentAssetFinanceBook } from "./reconcile-asset-finance"

export interface LoanTie {
  loanId: string
  reference: string
  journalCents: number
  bookCents: number
}

export interface Reconciliation {
  journalTotalCents: number
  bookTotalCents: number
  mismatches: LoanTie[]
}

/** Contract-to-date receivable per consumer loan booked before `asOf`, and per asset-finance contract (reconcile-asset-finance.ts). */
export async function independentBook(db: Pick<typeof prisma, "$queryRaw">, tenantId: string, asOf: Date): Promise<Map<string, { reference: string; cents: number }>> {
  const rows = await db.$queryRaw<Array<{ id: string; reference: string; cents: bigint }>>(Prisma.sql`
    WITH l AS (
      SELECT ln."id", ln."reference", ln."principal", ln."status", ln."writeOffAt", ln."closedAt"
      FROM "Loan" ln WHERE ln."tenantId" = ${tenantId} AND ln."contractType" = 'LOAN' AND ln."startDate" < ${asOf}
    ),
    due AS (
      SELECT s."loanId", SUM(s."interestDue" + s."feesDue") AS amt
      FROM "RepaymentSchedule" s JOIN l ON l."id" = s."loanId"
      WHERE (CASE WHEN l."status" = 'COMPLETED' AND l."closedAt" < s."dueDate" THEN l."closedAt" ELSE s."dueDate" END) < ${asOf}
        AND NOT COALESCE(l."status" = 'WRITTEN_OFF' AND l."writeOffAt" < ${asOf} AND l."writeOffAt" <= s."dueDate", false)
        AND NOT COALESCE(l."status" = 'CANCELLED' AND l."closedAt" <= s."dueDate", false)
      GROUP BY s."loanId"
    ),
    chg AS (
      SELECT c."loanId", SUM(c."amount") AS amt
      FROM "LoanCharge" c JOIN l ON l."id" = c."loanId"
      WHERE (CASE WHEN l."status" = 'COMPLETED' AND l."closedAt" < (c."day"::timestamp - interval '2 hours') THEN l."closedAt" ELSE c."day"::timestamp - interval '2 hours' END) < ${asOf}
        AND NOT COALESCE(l."status" = 'WRITTEN_OFF' AND l."writeOffAt" < ${asOf} AND l."writeOffAt" <= c."day"::timestamp - interval '2 hours', false)
        AND NOT COALESCE(l."status" = 'CANCELLED' AND l."closedAt" <= c."day"::timestamp - interval '2 hours', false)
      GROUP BY c."loanId"
    ),
    rcp AS (
      SELECT p."loanId", SUM(p."amount") AS amt
      FROM "Payment" p JOIN l ON l."id" = p."loanId"
      WHERE p."receivedAt" < ${asOf}
        AND NOT COALESCE(p."reversed" AND p."reversedAt" < ${asOf}, false)
        AND p."allocationStatus" = 'ALLOCATED' AND (p."reconciledAt" IS NULL OR p."reconciledAt" < ${asOf})
        AND NOT COALESCE(l."status" = 'WRITTEN_OFF' AND l."writeOffAt" < ${asOf} AND l."writeOffAt" <= p."receivedAt", false)
      GROUP BY p."loanId"
    )
    SELECT l."id", l."reference",
      (CASE
        WHEN EXISTS (SELECT 1 FROM "DisbursementReversal" r WHERE r."loanId" = l."id" AND r."status" = 'APPROVED' AND r."decidedAt" < ${asOf}) THEN 0
        WHEN l."status" = 'WRITTEN_OFF' AND l."writeOffAt" < ${asOf}
          THEN LEAST(0, l."principal" + COALESCE(due.amt, 0) + COALESCE(chg.amt, 0) - COALESCE(rcp.amt, 0))
        ELSE l."principal" + COALESCE(due.amt, 0) + COALESCE(chg.amt, 0) - COALESCE(rcp.amt, 0)
      END)::bigint AS cents
    FROM l LEFT JOIN due ON due."loanId" = l."id" LEFT JOIN chg ON chg."loanId" = l."id" LEFT JOIN rcp ON rcp."loanId" = l."id"
  `)
  const consumer = new Map(rows.map((r) => [r.id, { reference: r.reference, cents: Number(r.cents) }]))
  for (const [id, row] of await independentAssetFinanceBook(db, tenantId, asOf)) consumer.set(id, row)
  return consumer
}

/** The journal's receivables per loan once `entries` are added to what is posted. */
export function journalBook(
  posted: PostedLedger,
  postedLoans: Map<string, { loanId: string | null; reference: string }>,
  entries: DerivedEntry[],
): Map<string, number> {
  const out = new Map<string, number>()
  const add = (loanId: string | null | undefined, cents: number) => {
    if (loanId && cents) out.set(loanId, (out.get(loanId) ?? 0) + cents)
  }
  for (const [baseKey, vector] of posted) add(postedLoans.get(baseKey)?.loanId, RECEIVABLE_ROLES.reduce((sum, role) => sum + (vector[role] ?? 0), 0))
  for (const e of entries) {
    if (e.eventType === "OPENING") continue
    for (const l of e.lines) if (RECEIVABLE_ROLES.includes(l.sourceRole ?? l.role)) add(e.loanId, l.debitCents - l.creditCents)
  }
  return out
}

export function compareBooks(journal: Map<string, number>, book: Map<string, { reference: string; cents: number }>): Reconciliation {
  const ids = new Set([...journal.keys(), ...book.keys()])
  const mismatches: LoanTie[] = []
  let journalTotal = 0
  let bookTotal = 0
  for (const id of [...ids].sort()) {
    const j = journal.get(id) ?? 0
    const b = book.get(id)?.cents ?? 0
    journalTotal += j
    bookTotal += b
    if (j !== b) mismatches.push({ loanId: id, reference: book.get(id)?.reference ?? id, journalCents: j, bookCents: b })
  }
  return { journalTotalCents: journalTotal, bookTotalCents: bookTotal, mismatches }
}
