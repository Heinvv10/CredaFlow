/** Reads the loans a run stages, and the stage each was in on its latest earlier snapshot. */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { collectibleLoanWhere } from "@/lib/loan/collectible-book"
import type { RunLoan } from "./snapshot"
import type { PriorStaging } from "./staging"
import type { SicrFlagKind, Stage } from "./types"

type Db = Pick<typeof prisma, "loan" | "$queryRaw">

/** The collectible book (lib/loan/collectible-book.ts): ACTIVE, DEFAULTED, PENDING_WRITE_OFF, RESTRUCTURED. */
export async function loadRunLoans(db: Pick<Db, "loan">, tenantId: string): Promise<RunLoan[]> {
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
  return loans.map(({ repaymentSchedule, ifrs9Flags, debtReviewNoticeAt, ...loan }) => ({
    ...loan,
    debtReview: debtReviewNoticeAt !== null,
    schedule: repaymentSchedule,
    flags: [...new Set(ifrs9Flags.map((f) => f.kind as SicrFlagKind))],
  }))
}

/**
 * Each loan's staging on its latest earlier snapshot of any run (same-day runs: the later wins). One row per loan,
 * in the database: the history is every loan x every run, too much to fetch and thin out here.
 */
export async function loadPriorStaging(db: Pick<Db, "$queryRaw">, tenantId: string): Promise<Map<string, PriorStaging>> {
  const rows = await db.$queryRaw<Array<{ loanId: string; stage: number; stageSince: string; cureStartedOn: string | null }>>(Prisma.sql`
    SELECT DISTINCT ON ("loanId") "loanId", "stage", "stageSince"::text AS "stageSince", "cureStartedOn"::text AS "cureStartedOn"
    FROM "Ifrs9LoanSnapshot"
    WHERE "tenantId" = ${tenantId}
    ORDER BY "loanId", "runDate" DESC, "createdAt" DESC
  `)
  return new Map(rows.map((r) => [r.loanId, { stage: r.stage as Stage, stageSince: r.stageSince, cureStartedOn: r.cureStartedOn }]))
}
