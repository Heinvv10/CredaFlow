/** Reads the loans a run stages, and the stage each was in at the latest earlier MONTHLY run. */
import { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { collectibleLoanWhere } from "@/lib/loan/collectible-book"
import { loadAsOfLoans, scheduleAsOf } from "@/lib/reports/book-as-of"
import { sastCalendarDate } from "@/lib/date/sast"
import { addPeriods } from "@/lib/product-engine/periods"
import type { GraceDeferral } from "./ecl"
import type { RunLoan } from "./snapshot"
import type { PriorStaging } from "./staging"
import type { SicrFlagKind, Stage } from "./types"

type Db = Pick<typeof prisma, "loan" | "payment" | "auditLog" | "repaymentSchedule" | "bankTransaction" | "loanCharge" | "ifrs9Run" | "loanChange" | "$queryRaw">

const BASE_SELECT = {
  id: true, reference: true, productId: true, contractType: true, status: true, collectionsStage: true, debtReviewNoticeAt: true,
  startDate: true, principal: true, outstandingPrincipal: true, chargesOutstanding: true, restructuredAt: true, defaultedAtRestructure: true,
  ifrs9Flags: { where: { clearedAt: null }, select: { kind: true } },
  // The terms in force (lib/product-engine): a full grace defers interest that is earned in the grace.
  terms: { orderBy: { sequence: "desc" }, take: 1, select: { sequence: true, frequency: true, graceKind: true, graceInstalments: true, deferredInterest: true } },
} as const

type BaseRow = Prisma.LoanGetPayload<{ select: typeof BASE_SELECT }>

function graceDeferralOf(row: BaseRow): GraceDeferral | undefined {
  const t = row.terms[0]
  // A later change's holiday runs from its own date, not the loan's start: its deferred interest accrues with the row that carries it.
  if (!t || t.sequence !== 1 || t.graceKind !== "FULL" || !t.frequency || t.deferredInterest <= 0) return undefined
  return { endDate: sastCalendarDate(addPeriods(row.startDate, t.frequency, t.graceInstalments)), cents: t.deferredInterest }
}

function runLoan(row: BaseRow, schedule: RunLoan["schedule"], outstandingPrincipal: number, status = row.status): RunLoan {
  const graceDeferral = graceDeferralOf(row)
  return {
    ...(graceDeferral ? { graceDeferral } : {}),
    id: row.id, reference: row.reference, productId: row.productId, contractType: row.contractType, status,
    collectionsStage: row.collectionsStage, startDate: row.startDate, principal: row.principal, outstandingPrincipal,
    chargesOutstanding: row.chargesOutstanding, debtReview: row.debtReviewNoticeAt !== null, schedule,
    restructuredOn: row.restructuredAt ? sastCalendarDate(row.restructuredAt) : null, defaultedAtRestructure: row.defaultedAtRestructure,
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
export async function loadRunLoans(db: Pick<Db, "loan" | "payment" | "auditLog" | "repaymentSchedule" | "bankTransaction" | "loanChange">, tenantId: string, runAt: Date, asOf: Date | null): Promise<RunLoan[]> {
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
  // A later restructure has moved Loan.restructuredAt past this month: the one that stood then is in the change history.
  const movedOn = rows.filter((row) => row.restructuredAt !== null && row.restructuredAt > runAt).map((row) => row.id)
  const standing = movedOn.length === 0 ? [] : await db.loanChange.findMany({
    where: { tenantId, loanId: { in: movedOn }, markedRestructured: true, appliedAt: { lte: runAt } },
    orderBy: [{ loanId: "asc" }, { appliedAt: "desc" }], distinct: ["loanId"], select: { loanId: true, appliedAt: true },
  })
  const restructuredThen = new Map(standing.map((change) => [change.loanId, change.appliedAt]))
  return rows.map((row) => {
    const schedule = scheduleAsOf(byId.get(row.id)!, asOf).map(({ dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid }) => ({ dueDate, principalDue, interestDue, feesDue, totalDue, totalPaid }))
    const status = byId.get(row.id)!.statusAsOf ?? (row.status === "COMPLETED" || row.status === "WRITTEN_OFF" ? "ACTIVE" : row.status)
    return runLoan({ ...row, restructuredAt: restructuredThen.get(row.id) ?? row.restructuredAt }, schedule, recomputeLoanBalances(row.principal, schedule, runAt).outstandingPrincipal, status)
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
  const rows = await db.$queryRaw<Array<{ loanId: string; stage: number; stageSince: string; cureStartedOn: string | null; restructured: boolean; runDate: string }>>(Prisma.sql`
    SELECT DISTINCT ON (s."loanId") s."loanId", s."stage", s."stageSince"::text AS "stageSince", s."cureStartedOn"::text AS "cureStartedOn", s."restructured", r."runDate"::text AS "runDate"
    FROM "Ifrs9LoanSnapshot" s
    JOIN "Ifrs9Run" r ON r."id" = s."runId" AND r."tenantId" = s."tenantId"
    WHERE s."tenantId" = ${tenantId} AND r."kind" = 'MONTHLY' AND r."runDate" < ${before}::date
      AND NOT EXISTS (SELECT 1 FROM "Ifrs9Run" newer WHERE newer."tenantId" = r."tenantId" AND newer."supersedesRunId" = r."id")
    ORDER BY s."loanId", r."runDate" DESC, r."createdAt" DESC
  `)
  return new Map(rows.map((r) => [r.loanId, {
    stage: r.stage as Stage, stageSince: r.stageSince, cureStartedOn: r.cureStartedOn, restructured: r.restructured, runDate: r.runDate,
  }]))
}

/**
 * A loan booked by a top-up, refinance or consolidation (lib/loan-changes) starts from the worst stage of the loans it paid off,
 * until it has a run of its own: replacing a Stage 3 loan does not cure it.
 */
export async function inheritPriorStaging(db: Pick<Db, "loanChange">, tenantId: string, priors: Map<string, PriorStaging>): Promise<void> {
  // Oldest first: a loan replaced twice since the last run inherits through the one between.
  const changes = await db.loanChange.findMany({ where: { tenantId, newLoanId: { not: null } }, orderBy: { appliedAt: "asc" }, select: { newLoanId: true, sourceLoanIds: true } })
  for (const change of changes) {
    if (priors.has(change.newLoanId!)) continue
    const old = change.sourceLoanIds.flatMap((id) => priors.get(id) ?? [])
    const worst = old.reduce<PriorStaging | null>((max, prior) => (!max || prior.stage > max.stage ? prior : max), null)
    if (worst) priors.set(change.newLoanId!, worst)
  }
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
