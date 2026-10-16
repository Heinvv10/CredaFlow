import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { chargesLiveForTenant } from "@/lib/loan/charges-replay"
import { collectibleLoanWhere } from "@/lib/loan/collectible-book"

// Book, arrears and PAR: ONE helper for every screen that states them — the
// dashboard, the collections page, the sidebar badge and the NCR return.
//
// The Fair Score audit (2026-10-16) saw four answers to one question: the
// sidebar said 14 accounts in arrears, collections 12, the dashboard 15; total
// arrears R328k on the dashboard and R149,598 on collections; PAR30 94.2%,
// 93.1% and 84.2%; the book R2.62m beside an NCR "collectible book" of R1.15m.
// Each screen had its own `where`. They now all read this module, and each
// renders BOOK_DEFINITIONS so the reader knows what the number counts.
//
// Scope is the one deliberate difference: the NCR return reports NCA credit
// agreements only (a NON_NCA asset-finance agreement is outside the Act), so it
// asks for scope "NCA"; the operational screens ask for "ALL". On a book with
// no asset finance the two are the same numbers.

export type BookScope = "ALL" | "NCA"

export const BOOK_DEFINITIONS = {
  book: "Collectible book: outstanding principal of active, defaulted, restructured and pending write-off loans.",
  arrears: "In arrears: a collectible loan with an overdue unpaid instalment (1+ days past due), or with default charges owed. Amount = overdue instalments plus default charges owed.",
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

export interface BookArrears {
  scope: BookScope
  chargesLive: boolean
  book: { count: number; value: number }
  arrears: { count: number; amount: number; outstandingPrincipal: number }
  par30: ParBand
  par60: ParBand
  par90: ParBand
}

function scoped(where: Prisma.LoanWhereInput, scope: BookScope): Prisma.LoanWhereInput {
  return scope === "NCA" ? { ...where, ncaRegime: "NCA" } : where
}

/**
 * Collectible loans in arrears. Overdue on the schedule means a past-due day
 * count AND an unpaid amount AND principal still owed: a fully repaid loan that
 * still carries a stale DPD or arrears figure is not in arrears (audit
 * N-03/N-05). While default charges are live, a loan whose schedule is paid but
 * whose charges are owed is in arrears too.
 */
export function inArrearsWhere(tenantId: string, chargesLive: boolean, scope: BookScope = "ALL"): Prisma.LoanWhereInput {
  const overdueOnSchedule: Prisma.LoanWhereInput = {
    daysInArrears: { gt: 0 },
    arrearsAmount: { gt: 0 },
    outstandingPrincipal: { gt: 0 },
  }
  return scoped({
    ...collectibleLoanWhere(tenantId),
    ...(chargesLive
      ? { OR: [overdueOnSchedule, { chargesOutstanding: { gt: 0 } }] }
      : overdueOnSchedule),
  }, scope)
}

/** Loans in arrears at or beyond `minDays` past due: the PAR numerator. */
export function parBandWhere(tenantId: string, chargesLive: boolean, minDays: number, scope: BookScope = "ALL"): Prisma.LoanWhereInput {
  // AND, not a spread: the arrears predicate already constrains daysInArrears.
  return { ...inArrearsWhere(tenantId, chargesLive, scope), AND: [{ daysInArrears: { gte: minDays } }] }
}

type BookDb = Pick<typeof prisma, "loan" | "tenantConfig">

/** The sidebar badge: the arrears count only, from the same `where`. */
export async function countLoansInArrears(tenantId: string, db: BookDb = prisma): Promise<number> {
  const chargesLive = await chargesLiveForTenant(db, tenantId)
  return db.loan.count({ where: inArrearsWhere(tenantId, chargesLive) })
}

export async function getBookArrears(
  tenantId: string,
  scope: BookScope = "ALL",
  db: BookDb = prisma,
): Promise<BookArrears> {
  const chargesLive = await chargesLiveForTenant(db, tenantId)
  const band = (minDays: number) => db.loan.aggregate({
    where: parBandWhere(tenantId, chargesLive, minDays, scope),
    _count: true,
    _sum: { outstandingPrincipal: true },
  })
  const [book, arrears, p30, p60, p90] = await Promise.all([
    db.loan.aggregate({
      where: scoped(collectibleLoanWhere(tenantId), scope),
      _count: true,
      _sum: { outstandingPrincipal: true },
    }),
    db.loan.aggregate({
      where: inArrearsWhere(tenantId, chargesLive, scope),
      _count: true,
      _sum: { arrearsAmount: true, chargesOutstanding: true, outstandingPrincipal: true },
    }),
    band(30),
    band(60),
    band(90),
  ])
  const bookValue = Number(book._sum.outstandingPrincipal ?? 0)
  const toBand = (agg: { _count: number; _sum: { outstandingPrincipal: number | null } }): ParBand => {
    const value = Number(agg._sum.outstandingPrincipal ?? 0)
    return { count: agg._count, value, pct: bookValue > 0 ? (value / bookValue) * 100 : 0 }
  }
  return {
    scope,
    chargesLive,
    book: { count: book._count, value: bookValue },
    arrears: {
      count: arrears._count,
      amount: Number(arrears._sum.arrearsAmount ?? 0) + (chargesLive ? Number(arrears._sum.chargesOutstanding ?? 0) : 0),
      outstandingPrincipal: Number(arrears._sum.outstandingPrincipal ?? 0),
    },
    par30: toBand(p30),
    par60: toBand(p60),
    par90: toBand(p90),
  }
}
