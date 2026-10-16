import type { Prisma } from "@prisma/client"
import type { prisma } from "@/lib/prisma"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"
import { dayEnd, dayStart, dbDateToDay, monthStartOf, type Day } from "./period"
import type { HoldReason } from "./validate"

// WHICH loans go in a file. Everything here is computed against the LIVE
// ledger — what the bureau has actually been told — whatever mode the file
// being generated is in, so a TEST file is what the LIVE file would be.

type Db = Pick<typeof prisma, "loan" | "bureauSubmissionRecord">

/**
 * PO funding is not reported (product rule). ASSET_FINANCE is reported as
 * before it had its own type (its products were PERSONAL): only a natural
 * person's loan reaches the file (CONSUMER_BORROWER_WHERE), i.e. a sole
 * proprietor's NCA instalment sale or finance lease.
 */
export const REPORTED_PRODUCT_TYPES = ["MICRO", "PERSONAL", "ASSET_FINANCE"] as const

/**
 * The consumer file reports natural persons' credit: a loan to a business
 * entity (asset finance, Loan.entityId) is never a candidate, whatever its
 * product or regime, and nor is an operating or full-maintenance lease, a
 * sole proprietor's included (a lease is not a credit agreement; slice 3
 * default, // UNTESTED: legal). One rule, in every population query of this module.
 */
export const CONSUMER_BORROWER_WHERE = {
  entityId: null,
  contractType: { notIn: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] },
} as const satisfies Prisma.LoanWhereInput

export interface LedgerHistory {
  /** the bureau has been sent at least one line for this loan */
  known: boolean
  /** once-only statuses sent in a monthly file */
  monthlySent: string[]
  /** closure statuses sent in a daily file */
  dailySent: string[]
  /** the status dates of those daily closures, as YYYY-MM-DD */
  dailyClosureDays: string[]
  /** a daily registration (R) was sent */
  dailyRegistered: boolean
}

export const NO_HISTORY: LedgerHistory = { known: false, monthlySent: [], dailySent: [], dailyClosureDays: [], dailyRegistered: false }

/** What the bureau has been told about each loan: sent LIVE lines only. */
export async function loadLedgerHistory(db: Db, tenantId: string): Promise<Map<string, LedgerHistory>> {
  const rows = await db.bureauSubmissionRecord.findMany({
    where: { tenantId, mode: "LIVE", heldReason: null },
    distinct: ["loanId", "kind", "dataFlag", "statusCode", "statusDate"],
    select: { loanId: true, kind: true, dataFlag: true, statusCode: true, statusDate: true },
  })
  const histories = new Map<string, LedgerHistory>()
  for (const row of rows) {
    const history = histories.get(row.loanId)
      ?? { known: true, monthlySent: [], dailySent: [], dailyClosureDays: [], dailyRegistered: false }
    if (row.kind === "MONTHLY" && row.statusCode) history.monthlySent.push(row.statusCode)
    if (row.kind === "DAILY" && row.statusCode) {
      history.dailySent.push(row.statusCode)
      if (row.statusDate) history.dailyClosureDays.push(dbDateToDay(row.statusDate))
    }
    if (row.kind === "DAILY" && row.dataFlag === "R") history.dailyRegistered = true
    histories.set(row.loanId, history)
  }
  return histories
}

export type Disposition =
  | { action: "INCLUDE" }
  | { action: "DROP" }
  | { action: "HOLD"; reason: HoldReason }

const sentAny = (sent: string[], codes: string[]) => codes.some((code) => sent.includes(code))

/** Whether a loan belongs in a monthly file, given what was already sent. */
export function monthlyDisposition(loanStatus: string, history: LedgerHistory): Disposition {
  // Written off or deceased was the last word on the account: it is dropped.
  if (sentAny(history.monthlySent, ["W", "Z"])) return { action: "DROP" }
  if (loanStatus === "COMPLETED") {
    // The closure repeats once in the monthly file, then the account is gone.
    return sentAny(history.monthlySent, ["C", "T"]) ? { action: "DROP" } : { action: "INCLUDE" }
  }
  if (loanStatus === "CANCELLED") {
    // A cancellation of a registered account needs a V (cooling-off), which is
    // not automated. Unknown to the bureau, it was simply never reported.
    return history.known ? { action: "HOLD", reason: "CANCELLED_AFTER_REGISTRATION" } : { action: "DROP" }
  }
  if (loanStatus === "WRITTEN_OFF") {
    // A write-off under R100 went as C; that was its last word too.
    return history.monthlySent.includes("C") ? { action: "DROP" } : { action: "INCLUDE" }
  }
  // Open again after the bureau was told it closed (a reversed payment). A
  // file cannot undo a closure, so it is never silently re-registered.
  if (sentAny([...history.monthlySent, ...history.dailySent], ["C", "T"])) {
    return { action: "HOLD", reason: "REOPENED_AFTER_CLOSURE" }
  }
  return { action: "INCLUDE" }
}

/**
 * Candidate loans for the month ending `periodDay`: the book open at period
 * end, loans closed or written off in the period, and anything the bureau
 * still believes is open. Loans closed before the reporting start date were
 * never reported and never are.
 */
export async function monthlyCandidateIds(
  db: Db,
  args: { tenantId: string; periodDay: Day; reportingStartDay: Day; knownLoanIds: string[] },
): Promise<string[]> {
  const periodStart = dayStart(monthStartOf(args.periodDay))
  const periodEnd = dayEnd(args.periodDay)
  const reportingStart = dayStart(args.reportingStartDay)
  const loans = await db.loan.findMany({
    where: {
      tenantId: args.tenantId,
      ...CONSUMER_BORROWER_WHERE,
      product: { productType: { in: [...REPORTED_PRODUCT_TYPES] } },
      startDate: { lt: periodEnd },
      OR: [
        { status: { in: [...COLLECTIBLE_STATUSES] } },
        { status: "WRITTEN_OFF", writeOffAt: { gte: reportingStart } },
        // Closed in the period, or closed since (it was open at period end).
        { status: "COMPLETED", closedAt: { gte: periodStart > reportingStart ? periodStart : reportingStart } },
        { id: { in: args.knownLoanIds } },
      ],
    },
    select: { id: true },
    orderBy: { reference: "asc" },
  })
  return loans.map((loan) => loan.id)
}

/** Loans opened and loans closed on `day`. */
export async function dailyCandidateIds(
  db: Db,
  args: { tenantId: string; day: Day; reportingStartDay: Day; knownLoanIds: string[] },
): Promise<{ registrations: string[]; closures: string[] }> {
  const on = { gte: dayStart(args.day), lt: dayEnd(args.day) }
  const reportingStart = dayStart(args.reportingStartDay)
  const base = {
    tenantId: args.tenantId,
    ...CONSUMER_BORROWER_WHERE,
    product: { productType: { in: [...REPORTED_PRODUCT_TYPES] } },
  }
  const [registrations, closures] = await Promise.all([
    // startDate is inside the day, so "on or after the reporting start date"
    // is the same test as the day itself being on or after it.
    dayStart(args.day) < reportingStart ? [] : db.loan.findMany({
      where: { ...base, startDate: on, status: { not: "CANCELLED" } },
      select: { id: true },
      orderBy: { reference: "asc" },
    }),
    db.loan.findMany({
      where: {
        ...base,
        status: "COMPLETED",
        closedAt: on,
        // A closure only means something for an account the bureau has.
        OR: [{ startDate: { gte: reportingStart } }, { id: { in: args.knownLoanIds } }],
      },
      select: { id: true },
      orderBy: { reference: "asc" },
    }),
  ])
  return { registrations: registrations.map((l) => l.id), closures: closures.map((l) => l.id) }
}
