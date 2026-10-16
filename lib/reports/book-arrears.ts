import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { chargesLiveForTenant } from "@/lib/loan/charges-replay"
import { collectibleLoanWhere } from "@/lib/loan/collectible-book"
import { ARREARS_BANDS, type ArrearsBucketLabel } from "@/lib/reports/arrears-buckets"

// Book, arrears, ageing and PAR: ONE helper for every screen that states them —
// the dashboard, the collections page, the sidebar badge, the reports overview,
// the board pack, the spreadsheet exports and the NCR return.
//
// The Fair Score audit (2026-10-16) saw four answers to one question: the
// sidebar said 14 accounts in arrears, collections 12, the dashboard 15; total
// arrears R328k on the dashboard and R149,598 on collections; PAR30 94.2%,
// 93.1% and 84.2%; the book R2.62m beside an NCR "collectible book" of R1.15m.
// Each screen had its own `where`. They now all read this module, and each
// renders BOOK_DEFINITIONS so the reader knows what the number counts.
//
// Two populations, kept apart:
//   OVERDUE      — 1+ days past due with an instalment unpaid. This is "in
//                  arrears" on every screen and on the regulator's return, and
//                  the population of every ageing band and PAR figure.
//   CHARGES ONLY — schedule paid, default charges still owed (only while
//                  charges are live). Not days past due, so never in a DPD line;
//                  reported beside it, and worked in the collections queue.
//
// Scope is the one deliberate difference: the NCR return reports NCA credit
// agreements only (a NON_NCA asset-finance agreement is outside the Act), so it
// asks for scope "NCA"; the operational screens ask for "ALL". On a book with
// no asset finance the two are the same numbers.

export type BookScope = "ALL" | "NCA"

export const BOOK_DEFINITIONS = {
  book: "Collectible book: outstanding principal of active, defaulted, restructured and pending write-off loans.",
  arrears: "In arrears: a collectible loan 1+ days past due with an instalment unpaid. Amount = overdue instalments, plus default charges owed on those loans while charges are live.",
  chargesOnly: "Owing default charges only: instalments paid, default charges still owed. Not days past due, so counted separately.",
  par: "PAR30 / 60 / 90: outstanding principal of loans in arrears 30 / 60 / 90+ days, as a share of the collectible book.",
  scopeAll: "All agreements, asset finance included.",
  scopeNca: "NCA credit agreements only (asset-finance agreements outside the Act are excluded).",
} as const

export interface ParBand {
  /** Loans in arrears at or beyond this many days past due. */
  count: number
  /** Their outstanding principal, cents. */
  value: number
  /** value as a share of the collectible book, 0–100. */
  pct: number
}

export interface AgeingBand {
  label: ArrearsBucketLabel
  count: number
  /** overdue instalments, cents */
  arrearsAmount: number
  outstandingPrincipal: number
}

export interface BookArrears {
  scope: BookScope
  chargesLive: boolean
  book: { count: number; value: number }
  /** OVERDUE: 1+ days past due */
  arrears: { count: number; amount: number; outstandingPrincipal: number }
  /** CHARGES ONLY: 0 while charges are off */
  chargesOnly: { count: number; amount: number }
  ageing: AgeingBand[]
  par30: ParBand
  par60: ParBand
  par90: ParBand
}

function scoped(where: Prisma.LoanWhereInput, scope: BookScope): Prisma.LoanWhereInput {
  return scope === "NCA" ? { ...where, ncaRegime: "NCA" } : where
}

// Past due AND an unpaid amount AND principal still owed: a fully repaid loan
// that still carries a stale DPD or arrears figure is not in arrears (audit
// N-03/N-05).
const OVERDUE: Prisma.LoanWhereInput = { daysInArrears: { gt: 0 }, arrearsAmount: { gt: 0 }, outstandingPrincipal: { gt: 0 } }

/** OVERDUE collectible loans: "in arrears" on every screen and on the NCR return. */
export function overdueWhere(tenantId: string, scope: BookScope = "ALL"): Prisma.LoanWhereInput {
  return scoped({ ...collectibleLoanWhere(tenantId), ...OVERDUE }, scope)
}

/** OVERDUE loans minDays..maxDays past due (null: open-ended): ageing bands and PAR. */
export function overdueBandWhere(tenantId: string, minDays: number, maxDays: number | null = null, scope: BookScope = "ALL"): Prisma.LoanWhereInput {
  // AND, not a spread: OVERDUE already constrains daysInArrears.
  return { ...overdueWhere(tenantId, scope), AND: [{ daysInArrears: maxDays === null ? { gte: minDays } : { gte: minDays, lte: maxDays } }] }
}

/** CHARGES ONLY: not overdue, default charges owed. Meaningful only while charges are live. */
export function chargesOnlyWhere(tenantId: string, scope: BookScope = "ALL"): Prisma.LoanWhereInput {
  return scoped({ ...collectibleLoanWhere(tenantId), chargesOutstanding: { gt: 0 }, NOT: OVERDUE }, scope)
}

/** The collections work list: OVERDUE, or (while charges are live) CHARGES ONLY. */
export function inArrearsWhere(tenantId: string, chargesLive: boolean, scope: BookScope = "ALL"): Prisma.LoanWhereInput {
  return chargesLive
    ? scoped({ ...collectibleLoanWhere(tenantId), OR: [OVERDUE, { chargesOutstanding: { gt: 0 } }] }, scope)
    : overdueWhere(tenantId, scope)
}

type BookDb = Pick<typeof prisma, "loan" | "tenantConfig">

/** The sidebar badge: the collections work list, from the same definitions. */
export async function countLoansInArrears(tenantId: string, db: BookDb = prisma): Promise<number> {
  const chargesLive = await chargesLiveForTenant(db, tenantId)
  return db.loan.count({ where: inArrearsWhere(tenantId, chargesLive) })
}

const SUMS = { arrearsAmount: true, chargesOutstanding: true, outstandingPrincipal: true } as const

export async function getBookArrears(
  tenantId: string,
  scope: BookScope = "ALL",
  db: BookDb = prisma,
): Promise<BookArrears> {
  const chargesLive = await chargesLiveForTenant(db, tenantId)
  const aggregate = (where: Prisma.LoanWhereInput) => db.loan.aggregate({ where, _count: true, _sum: SUMS })
  const [book, overdue, chargesOnly, p30, p60, p90, ...ageing] = await Promise.all([
    aggregate(scoped(collectibleLoanWhere(tenantId), scope)),
    aggregate(overdueWhere(tenantId, scope)),
    chargesLive ? aggregate(chargesOnlyWhere(tenantId, scope)) : null,
    aggregate(overdueBandWhere(tenantId, 30, null, scope)),
    aggregate(overdueBandWhere(tenantId, 60, null, scope)),
    aggregate(overdueBandWhere(tenantId, 90, null, scope)),
    ...ARREARS_BANDS.map((band) => aggregate(overdueBandWhere(tenantId, band.min, band.max, scope))),
  ])
  const sum = (agg: { _sum: { outstandingPrincipal?: number | null; arrearsAmount?: number | null; chargesOutstanding?: number | null } }, key: keyof typeof SUMS) =>
    Number(agg._sum[key] ?? 0)
  const bookValue = sum(book, "outstandingPrincipal")
  const toBand = (agg: typeof p30): ParBand => {
    const value = sum(agg, "outstandingPrincipal")
    return { count: agg._count, value, pct: bookValue > 0 ? (value / bookValue) * 100 : 0 }
  }
  return {
    scope,
    chargesLive,
    book: { count: book._count, value: bookValue },
    arrears: {
      count: overdue._count,
      amount: sum(overdue, "arrearsAmount") + (chargesLive ? sum(overdue, "chargesOutstanding") : 0),
      outstandingPrincipal: sum(overdue, "outstandingPrincipal"),
    },
    chargesOnly: chargesOnly ? { count: chargesOnly._count, amount: sum(chargesOnly, "chargesOutstanding") } : { count: 0, amount: 0 },
    ageing: ARREARS_BANDS.map((band, i) => ({
      label: band.label,
      count: ageing[i]._count,
      arrearsAmount: sum(ageing[i], "arrearsAmount"),
      outstandingPrincipal: sum(ageing[i], "outstandingPrincipal"),
    })),
    par30: toBand(p30),
    par60: toBand(p60),
    par90: toBand(p90),
  }
}
