import type { CollectionsStage, LoanStatus, NcaRegime } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { chargesLiveForTenant } from "@/lib/loan/charges-replay"
import { collectibleLoanWhere, COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { recomputeLoanBalances } from "@/lib/loan/balances"
import { sastCalendarDate } from "@/lib/date/sast"
import { ARREARS_BANDS } from "@/lib/reports/arrears-buckets"
import type { BookArrears, BookScope, ParBand } from "@/lib/reports/book-arrears"

// Daily arrears history (LoanArrearsSnapshot). The loan's own columns carry no
// history, so a closed quarter's NCR position lines could only show today's
// book. The nightly /api/cron/arrears-snapshot keeps one row per collectible
// loan per SAST day; the NCR return reads the quarter's last day
// (lib/compliance/ncr-return.ts). Nothing is backfilled: history starts on the
// first run, and the return says so.
//
// The figures are the ones lib/reports/book-arrears.ts reads, by its
// definitions: the collectible book (collectibleLoanWhere), days past due and
// the overdue amount as the DPD cron derives them from the schedule
// (recomputeLoanBalances, lib/loan/balances.ts — computed here as of the run
// rather than read from the columns, which are only as fresh as that cron's
// last run), and outstanding principal and default charges as stored.
// `bookArrearsFromSnapshot` applies book-arrears' OVERDUE / band / PAR /
// charges-only predicates to the rows; an integration test holds the two equal.

export type SnapshotRow = {
  status: LoanStatus
  ncaRegime: NcaRegime
  collectionsStage: CollectionsStage
  daysInArrears: number
  arrearsCents: number
  outstandingPrincipalCents: number
  chargesOutstandingCents: number
  chargesLive: boolean
}

/** A SAST calendar day as the DATE column stores it (UTC midnight of that date). */
export function snapshotDay(instant: Date): Date {
  return new Date(`${sastCalendarDate(instant)}T00:00:00.000Z`)
}

type WriterDb = Pick<typeof prisma, "loan" | "tenantConfig" | "loanArrearsSnapshot">

/**
 * Record today's position for every collectible loan of one tenant. Idempotent
 * per day: a row that exists for (tenant, loan, day) is left as written.
 */
export async function snapshotTenantArrears(
  tenantId: string,
  asOf: Date,
  db: WriterDb = prisma,
): Promise<{ snapshotDate: string; loans: number; written: number }> {
  const snapshotDate = snapshotDay(asOf)
  const chargesLive = await chargesLiveForTenant(db, tenantId)
  const loans = await db.loan.findMany({
    where: collectibleLoanWhere(tenantId),
    select: {
      id: true, status: true, ncaRegime: true, collectionsStage: true, principal: true,
      outstandingPrincipal: true, chargesOutstanding: true,
      repaymentSchedule: {
        orderBy: { dueDate: "asc" },
        select: { dueDate: true, principalDue: true, interestDue: true, feesDue: true, totalDue: true, totalPaid: true },
      },
    },
  })
  const data = loans.map((loan) => {
    const live = recomputeLoanBalances(loan.principal, loan.repaymentSchedule, asOf)
    return {
      tenantId, loanId: loan.id, snapshotDate,
      status: loan.status, ncaRegime: loan.ncaRegime, collectionsStage: loan.collectionsStage,
      daysInArrears: live.daysInArrears,
      arrearsCents: live.arrearsAmount,
      outstandingPrincipalCents: Math.max(0, loan.outstandingPrincipal),
      chargesOutstandingCents: Math.max(0, loan.chargesOutstanding),
      chargesLive,
    }
  })
  const written = data.length === 0 ? 0 : (await db.loanArrearsSnapshot.createMany({ data, skipDuplicates: true })).count
  return { snapshotDate: sastCalendarDate(asOf), loans: loans.length, written }
}

type ReaderDb = Pick<typeof prisma, "loanArrearsSnapshot">

/** The rows for one SAST day, or none. */
export async function readSnapshotDay(tenantId: string, day: Date, db: ReaderDb = prisma): Promise<SnapshotRow[]> {
  return db.loanArrearsSnapshot.findMany({
    where: { tenantId, snapshotDate: day },
    select: {
      status: true, ncaRegime: true, collectionsStage: true, daysInArrears: true, arrearsCents: true,
      outstandingPrincipalCents: true, chargesOutstandingCents: true, chargesLive: true,
    },
  })
}

/** The first day history exists for, or null before the first run. */
export async function firstSnapshotDay(tenantId: string, db: ReaderDb = prisma): Promise<Date | null> {
  const first = await db.loanArrearsSnapshot.aggregate({ where: { tenantId }, _min: { snapshotDate: true } })
  return first._min.snapshotDate ?? null
}

const COLLECTIBLE: ReadonlySet<string> = new Set(COLLECTIBLE_STATUSES)

// lib/reports/book-arrears.ts OVERDUE: past due AND an unpaid amount AND principal still owed.
const overdue = (r: SnapshotRow) => r.daysInArrears > 0 && r.arrearsCents > 0 && r.outstandingPrincipalCents > 0
const inBand = (r: SnapshotRow, min: number, max: number | null) =>
  overdue(r) && r.daysInArrears >= min && (max === null || r.daysInArrears <= max)

export type SnapshotBook = BookArrears & {
  /** Accounts in default, by status, and their outstanding principal. */
  defaulted: { count: number; value: number }
  /** Collectible accounts referred to attorney. */
  attorneyReferred: number
}

/** The book-arrears figures, read from one day's snapshot rows. */
export function bookArrearsFromSnapshot(all: readonly SnapshotRow[], scope: BookScope): SnapshotBook {
  const rows = all.filter((r) => COLLECTIBLE.has(r.status) && (scope === "ALL" || r.ncaRegime === "NCA"))
  const chargesLive = rows.some((r) => r.chargesLive)
  const sum = (list: SnapshotRow[], key: "arrearsCents" | "outstandingPrincipalCents" | "chargesOutstandingCents") =>
    list.reduce((total, r) => total + r[key], 0)
  const bookValue = sum(rows, "outstandingPrincipalCents")
  const band = (min: number): ParBand => {
    const list = rows.filter((r) => inBand(r, min, null))
    const value = sum(list, "outstandingPrincipalCents")
    return { count: list.length, value, pct: bookValue > 0 ? (value / bookValue) * 100 : 0 }
  }
  const overdueRows = rows.filter(overdue)
  const chargesOnly = chargesLive ? rows.filter((r) => !overdue(r) && r.chargesOutstandingCents > 0) : []
  const defaulted = rows.filter((r) => r.status === "DEFAULTED")
  return {
    scope,
    chargesLive,
    book: { count: rows.length, value: bookValue },
    arrears: {
      count: overdueRows.length,
      amount: sum(overdueRows, "arrearsCents") + (chargesLive ? sum(overdueRows, "chargesOutstandingCents") : 0),
      outstandingPrincipal: sum(overdueRows, "outstandingPrincipalCents"),
    },
    chargesOnly: { count: chargesOnly.length, amount: sum(chargesOnly, "chargesOutstandingCents") },
    ageing: ARREARS_BANDS.map((b) => {
      const list = rows.filter((r) => inBand(r, b.min, b.max))
      return { label: b.label, count: list.length, arrearsAmount: sum(list, "arrearsCents"), outstandingPrincipal: sum(list, "outstandingPrincipalCents") }
    }),
    par30: band(30),
    par60: band(60),
    par90: band(90),
    defaulted: { count: defaulted.length, value: sum(defaulted, "outstandingPrincipalCents") },
    attorneyReferred: rows.filter((r) => r.collectionsStage === "ATTORNEY_REFERRED").length,
  }
}
