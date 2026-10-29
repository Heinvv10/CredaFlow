/** Reads the loans a run stages, and the stage each was in at the latest earlier MONTHLY run. */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { allocateReceipts, recomputeLoanBalances } from "@/lib/loan/balances"
import { collectibleLoanWhere } from "@/lib/loan/collectible-book"
import { scheduleShareAsOf } from "@/lib/reports/book-as-of"
import type { RunLoan } from "./snapshot"
import { wasRestructured, type PriorStaging } from "./staging"
import type { SicrFlagKind, Stage } from "./types"

type Db = Pick<typeof prisma, "loan" | "payment" | "$queryRaw">

/**
 * The collectible book (lib/loan/collectible-book.ts): ACTIVE, DEFAULTED, PENDING_WRITE_OFF, RESTRUCTURED.
 *
 * `receiptsBefore`: for a run made after the day it describes (a make-up, late or superseding monthly run) the
 * schedule's paid amounts and the outstanding principal are rebuilt from the receipts live before that instant,
 * as lib/reports/book-as-of.ts rebuilds a past book, so the position is the one at the period end and not today's.
 * Status, flags, collections stage and default charges are read as they are now (docs/ifrs9/DESIGN.md, limits).
 */
export async function loadRunLoans(db: Pick<Db, "loan" | "payment">, tenantId: string, runAt: Date, receiptsBefore: Date | null): Promise<RunLoan[]> {
  const loans = await db.loan.findMany({
    where: collectibleLoanWhere(tenantId),
    orderBy: { id: "asc" },
    select: {
      id: true, reference: true, productId: true, contractType: true, status: true, collectionsStage: true, debtReviewNoticeAt: true,
      startDate: true, principal: true, outstandingPrincipal: true, chargesOutstanding: true,
      repaymentSchedule: {
        orderBy: { dueDate: "asc" },
        select: { dueDate: true, principalDue: true, interestDue: true, feesDue: true, totalDue: true, totalPaid: true },
      },
      ifrs9Flags: { where: { clearedAt: null }, select: { kind: true } },
    },
  })
  const receipts = receiptsBefore ? await receiptsByLoan(db, tenantId, loans.map((l) => l.id)) : null
  return loans.map(({ repaymentSchedule, ifrs9Flags, debtReviewNoticeAt, ...loan }) => {
    let schedule = repaymentSchedule
    let outstandingPrincipal = loan.outstandingPrincipal
    if (receiptsBefore && receipts) {
      const paid = allocateReceipts(schedule, scheduleShareAsOf(receipts.get(loan.id) ?? [], receiptsBefore))
      schedule = schedule.map((row, i) => ({ ...row, totalPaid: paid[i] }))
      outstandingPrincipal = recomputeLoanBalances(loan.principal, schedule, runAt).outstandingPrincipal
    }
    return {
      id: loan.id, reference: loan.reference, productId: loan.productId, contractType: loan.contractType, status: loan.status,
      collectionsStage: loan.collectionsStage, startDate: loan.startDate, principal: loan.principal, outstandingPrincipal,
      chargesOutstanding: loan.chargesOutstanding,
      debtReview: debtReviewNoticeAt !== null,
      schedule,
      flags: [...new Set(ifrs9Flags.map((f) => f.kind as SicrFlagKind))],
    }
  })
}

async function receiptsByLoan(db: Pick<Db, "payment">, tenantId: string, loanIds: string[]): Promise<Map<string, Parameters<typeof scheduleShareAsOf>[0]>> {
  const rows = await db.payment.findMany({
    where: { tenantId, loanId: { in: loanIds } },
    select: {
      loanId: true, amount: true, receivedAt: true, reversed: true, reversedAt: true, allocationStatus: true,
      defaultInterestAllocated: true, chargeFeesAllocated: true,
    },
  })
  const byLoan = new Map<string, Parameters<typeof scheduleShareAsOf>[0]>()
  for (const { loanId, ...receipt } of rows) {
    const list = byLoan.get(loanId)
    if (list) list.push(receipt)
    else byLoan.set(loanId, [receipt])
  }
  return byLoan
}

/**
 * Each loan's staging at the latest MONTHLY run dated before `before` (a yyyy-mm-dd) that no run supersedes. Only
 * official runs: an on-demand analysis must never move the stage the next month-end starts from. One row per loan, in
 * the database: the history is every loan x every run, too much to fetch and thin out here.
 */
export async function loadPriorStaging(db: Pick<Db, "$queryRaw">, tenantId: string, before: string): Promise<Map<string, PriorStaging>> {
  const rows = await db.$queryRaw<Array<{ loanId: string; stage: number; stageSince: string; cureStartedOn: string | null; reasons: string[] }>>(Prisma.sql`
    SELECT DISTINCT ON (s."loanId") s."loanId", s."stage", s."stageSince"::text AS "stageSince", s."cureStartedOn"::text AS "cureStartedOn", s."reasons"
    FROM "Ifrs9LoanSnapshot" s
    JOIN "Ifrs9Run" r ON r."id" = s."runId" AND r."tenantId" = s."tenantId"
    WHERE s."tenantId" = ${tenantId} AND r."kind" = 'MONTHLY' AND r."runDate" < ${before}::date
      AND NOT EXISTS (SELECT 1 FROM "Ifrs9Run" newer WHERE newer."tenantId" = r."tenantId" AND newer."supersedesRunId" = r."id")
    ORDER BY s."loanId", r."runDate" DESC, r."createdAt" DESC
  `)
  return new Map(rows.map((r) => [r.loanId, {
    stage: r.stage as Stage, stageSince: r.stageSince, cureStartedOn: r.cureStartedOn, restructured: wasRestructured(r.reasons),
  }]))
}
