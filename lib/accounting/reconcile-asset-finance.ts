/**
 * The asset-finance part of the tie-out (see lib/accounting/reconcile.ts): per
 * contract, what the borrower owes to date, computed in SQL from the loan
 * tables and never through lib/accounting/sources-*.ts, so a fault in a source
 * shows up as a difference instead of agreeing with itself.
 *
 * Instalment sale and finance lease (once the inception invoice is supplied):
 *   owed = opening balance B of the first row not yet raised (0 when every row
 *          is) + the totalDue of the rows raised + default charges - applied receipts
 * This telescopes: the journal holds F + the interest each raised row accrues
 * = F + sum(B(next) - B(this) + totalDue), which is B(first row not raised) -
 * B(first row) + sum(totalDue) + F. It does not use F, so it holds source
 * #1's F to the schedule: F must equal the first row's opening balance.
 * A row is raised under the same rules as the journal (due before the period
 * end; an early-settled loan's remaining rows on the closing day; none on or
 * after a write-off or cancellation).
 *
 * Lease: the rentals invoiced (their total, once the invoice's supply date has
 * come) + the lease's other tax invoices (end of term, termination: they are
 * rows of the loan's schedule, lib/asset-finance/lease-charges.ts) + default
 * charges - applied receipts.
 * A written-off contract owes LEAST(0, the above), as for consumer loans.
 */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"

export type IndependentBook = Map<string, { reference: string; cents: number }>

/** A `date` column as the SAST-midnight instant it stands for (the same arithmetic as the default-charge `day`). */
const sastInstant = (column: string) => Prisma.raw(`(${column}::timestamp - interval '2 hours')`)

export async function independentAssetFinanceBook(db: Pick<typeof prisma, "$queryRaw">, tenantId: string, asOf: Date): Promise<IndependentBook> {
  const supply = sastInstant('i."supplyDate"')
  const chargeDay = sastInstant('c."day"')
  const rows = await db.$queryRaw<Array<{ id: string; reference: string; cents: bigint }>>(Prisma.sql`
    WITH l AS (
      SELECT ln."id", ln."reference", ln."status", ln."writeOffAt", ln."closedAt", ln."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') AS lease
      FROM "Loan" ln WHERE ln."tenantId" = ${tenantId} AND ln."contractType" <> 'LOAN'
    ),
    inc AS (
      SELECT DISTINCT ON (i."loanId") i."loanId", ${supply} AS "at"
      FROM "TaxInvoice" i JOIN l ON l."id" = i."loanId" AND NOT l.lease
      WHERE i."tenantId" = ${tenantId} ORDER BY i."loanId", i."number"
    ),
    rw AS (
      SELECT s."loanId", s."installmentNo", s."totalDue", s."assetFinanceOpeningBalanceCents" AS "opening",
        ((CASE WHEN l."status" = 'COMPLETED' AND l."closedAt" < s."dueDate" THEN l."closedAt" ELSE s."dueDate" END) < ${asOf}
          AND NOT COALESCE(l."status" = 'WRITTEN_OFF' AND l."writeOffAt" < ${asOf} AND l."writeOffAt" <= s."dueDate", false)
          AND NOT COALESCE(l."status" = 'CANCELLED' AND l."closedAt" <= s."dueDate", false)) AS "raised"
      FROM "RepaymentSchedule" s JOIN l ON l."id" = s."loanId" AND NOT l.lease
    ),
    due AS (SELECT "loanId", SUM("totalDue") AS amt FROM rw WHERE "raised" GROUP BY "loanId"),
    nxt AS (SELECT DISTINCT ON ("loanId") "loanId", "opening" FROM rw WHERE NOT "raised" ORDER BY "loanId", "installmentNo"),
    rent AS (
      SELECT r."loanId", SUM(r."totalCents") AS amt
      FROM "LeaseRental" r JOIN "TaxInvoice" i ON i."id" = r."taxInvoiceId" AND i."tenantId" = r."tenantId" JOIN l ON l."id" = r."loanId"
      WHERE ${supply} < ${asOf} GROUP BY r."loanId"
    ),
    sundry AS (
      SELECT i."loanId", SUM(i."totalInclVatCents") AS amt
      FROM "TaxInvoice" i JOIN l ON l."id" = i."loanId" AND l.lease
      WHERE i."tenantId" = ${tenantId} AND ${supply} < ${asOf}
        AND NOT EXISTS (SELECT 1 FROM "LeaseRental" r WHERE r."taxInvoiceId" = i."id") GROUP BY i."loanId"
    ),
    chg AS (
      SELECT c."loanId", SUM(c."amount") AS amt
      FROM "LoanCharge" c JOIN l ON l."id" = c."loanId"
      WHERE (CASE WHEN l."status" = 'COMPLETED' AND l."closedAt" < ${chargeDay} THEN l."closedAt" ELSE ${chargeDay} END) < ${asOf}
        AND NOT COALESCE(l."status" = 'WRITTEN_OFF' AND l."writeOffAt" < ${asOf} AND l."writeOffAt" <= ${chargeDay}, false)
        AND NOT COALESCE(l."status" = 'CANCELLED' AND l."closedAt" <= ${chargeDay}, false)
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
    ),
    owed AS (
      SELECT l."id", l."reference", l."status", l."writeOffAt",
        (CASE WHEN l.lease THEN COALESCE(rent.amt, 0) + COALESCE(sundry.amt, 0)
              ELSE COALESCE(nxt."opening", 0) + COALESCE(due.amt, 0) END
          + COALESCE(chg.amt, 0) - COALESCE(rcp.amt, 0)) AS cents
      FROM l LEFT JOIN due ON due."loanId" = l."id" LEFT JOIN nxt ON nxt."loanId" = l."id"
        LEFT JOIN rent ON rent."loanId" = l."id" LEFT JOIN sundry ON sundry."loanId" = l."id"
        LEFT JOIN chg ON chg."loanId" = l."id" LEFT JOIN rcp ON rcp."loanId" = l."id"
        LEFT JOIN inc ON inc."loanId" = l."id"
      WHERE l.lease OR inc."at" < ${asOf}
    )
    SELECT "id", "reference",
      (CASE WHEN "status" = 'WRITTEN_OFF' AND "writeOffAt" < ${asOf} THEN LEAST(0, cents) ELSE cents END)::bigint AS cents
    FROM owed
  `)
  return new Map(rows.map((r) => [r.id, { reference: r.reference, cents: Number(r.cents) }]))
}
