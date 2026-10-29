/** Reads the loans a run stages, and the stage each was in at the latest earlier MONTHLY run. */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { collectibleLoanWhere } from "@/lib/loan/collectible-book"
import { loadAsOfLoans, scheduleAsOf } from "@/lib/reports/book-as-of"
import type { RunLoan } from "./snapshot"
import type { PriorStaging } from "./staging"
import type { SicrFlagKind, Stage } from "./types"

type Db = Pick<typeof prisma, "loan" | "payment" | "auditLog" | "repaymentSchedule" | "bankTransaction" | "loanCharge" | "ifrs9Run" | "$queryRaw">

const BASE_SELECT = {
  id: true, reference: true, productId: true, contractType: true, status: true, collectionsStage: true, debtReviewNoticeAt: true,
  startDate: true, principal: true, outstandingPrincipal: true, chargesOutstanding: true,
  ifrs9Flags: { where: { clearedAt: null }, select: { kind: true } },
} as const

type BaseRow = Prisma.LoanGetPayload<{ select: typeof BASE_SELECT }>

function runLoan(row: BaseRow, schedule: RunLoan["schedule"], outstandingPrincipal: number, status = row.status): RunLoan {
  return {
    id: row.id, reference: row.reference, productId: row.productId, contractType: row.contractType, status,
    collectionsStage: row.collectionsStage, startDate: row.startDate, principal: row.principal, outstandingPrincipal,
    chargesOutstanding: row.chargesOutstanding, debtReview: row.debtReviewNoticeAt !== null, schedule,
    flags: [...new Set(row.ifrs9Flags.map((f) => f.kind as SicrFlagKind))],
  }
}

/**
 * The loans a run stages. Today: the collectible book (lib/loan/collectible-book.ts).
 *
 * `asOf`: for a run made after the day it describes (a make-up, late or superseding monthly run) the month-end book
 * instead, as lib/reports/book-as-of.ts rebuilds a past book: loans disbursed before `asOf` that were not yet closed or
 * written off then (so a loan that has exited since is still in, and one disbursed since is out), with the schedule's
 * paid amounts and the outstanding principal rebuilt from the receipts live before `asOf`. A cancelled disbursement is
 * out (the ledger never booked it). The status a loan had then is not recorded: one since completed or written off is
 * staged on its days past due alone. Flags, collections stage, debt review and default charges are read as they are
 * now (docs/ifrs9/DESIGN.md, limits).
 */
export async function loadRunLoans(db: Pick<Db, "loan" | "payment" | "auditLog" | "repaymentSchedule" | "bankTransaction">, tenantId: string, runAt: Date, asOf: Date | null): Promise<RunLoan[]> {
  if (!asOf) {
    const loans = await db.loan.findMany({
      where: collectibleLoanWhere(tenantId),
      orderBy: { id: "asc" },
      select: {
        ...BASE_SELECT,
        repaymentSchedule: {
          orderBy: { dueDate: "asc" },
          select: { dueDate: true, principalDue: true, interestDue: true, feesDue: true, totalDue: true, totalPaid: true },
        },
      },
    })
    return loans.map(({ repaymentSchedule, ...row }) => runLoan(row, repaymentSchedule, row.outstandingPrincipal))
  }
  const asOfLoans = await loadAsOfLoans(db, tenantId, asOf)
  const byId = new Map(asOfLoans.map((l) => [l.id as string, l]))
  const rows = await db.loan.findMany({ where: { tenantId, id: { in: [...byId.keys()] }, status: { not: "CANCELLED" } }, orderBy: { id: "asc" }, select: BASE_SELECT })
  return rows.map((row) => {
    const schedule = scheduleAsOf(byId.get(row.id)!, asOf).map(({ dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid }) => ({ dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid }))
    const status = row.status === "COMPLETED" || row.status === "WRITTEN_OFF" ? "ACTIVE" : row.status
    return runLoan(row, schedule, recomputeLoanBalances(row.principal, schedule, runAt).outstandingPrincipal, status)
  })
}

/** Default interest charged from `from` to `to` (yyyy-mm-dd, inclusive), per loan: the net basis adjusts it with the contractual interest. */
export async function loadDefaultInterestRaised(db: Pick<Db, "loanCharge">, tenantId: string, loanIds: string[], from: string, to: string): Promise<Map<string, number>> {
  const sums = await db.loanCharge.groupBy({
    by: ["loanId"],
    where: { tenantId, loanId: { in: loanIds }, type: "DEFAULT_INTEREST", day: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) } },
    _sum: { amount: true },
  })
  return new Map(sums.map((r) => [r.loanId, r._sum.amount ?? 0]))
}

/**
 * Each loan's staging at the latest MONTHLY run dated before `before` (a yyyy-mm-dd) that no run supersedes. Only
 * official runs: an on-demand analysis must never move the stage the next month-end starts from. One row per loan, in
 * the database: the history is every loan x every run, too much to fetch and thin out here.
 */
export async function loadPriorStaging(db: Pick<Db, "$queryRaw">, tenantId: string, before: string): Promise<Map<string, PriorStaging>> {
  const rows = await db.$queryRaw<Array<{ loanId: string; stage: number; stageSince: string; cureStartedOn: string | null; restructured: boolean }>>(Prisma.sql`
    SELECT DISTINCT ON (s."loanId") s."loanId", s."stage", s."stageSince"::text AS "stageSince", s."cureStartedOn"::text AS "cureStartedOn", s."restructured"
    FROM "Ifrs9LoanSnapshot" s
    JOIN "Ifrs9Run" r ON r."id" = s."runId" AND r."tenantId" = s."tenantId"
    WHERE s."tenantId" = ${tenantId} AND r."kind" = 'MONTHLY' AND r."runDate" < ${before}::date
      AND NOT EXISTS (SELECT 1 FROM "Ifrs9Run" newer WHERE newer."tenantId" = r."tenantId" AND newer."supersedesRunId" = r."id")
    ORDER BY s."loanId", r."runDate" DESC, r."createdAt" DESC
  `)
  return new Map(rows.map((r) => [r.loanId, {
    stage: r.stage as Stage, stageSince: r.stageSince, cureStartedOn: r.cureStartedOn, restructured: r.restructured,
  }]))
}

/**
 * The MONTHLY runs `loadPriorStaging` reads from for a run dated `before` (the ones no run supersedes), as one comparable
 * string. A run takes it before it reads its prior stages and again under the accounting lock: if it changed, the stages
 * were read from a run that has since been replaced and the run is refused.
 */
export async function priorRunFingerprint(db: Pick<Db, "ifrs9Run">, tenantId: string, before: string): Promise<string> {
  const runs = await db.ifrs9Run.findMany({
    where: { tenantId, kind: "MONTHLY", runDate: { lt: new Date(`${before}T00:00:00.000Z`) }, supersededBy: null },
    select: { id: true }, orderBy: { id: "asc" },
  })
  return runs.map((r) => r.id).join(",")
}
