import { prisma } from "@/lib/prisma"
import { collectibleLoanWhere, collectibleParWhere } from "@/lib/loan/collectible-book"

// Portfolio-at-Risk — VALUE-WEIGHTED, over the COLLECTIBLE BOOK.
//
//   PARx% = Σ outstandingPrincipal of collectible loans with DPD >= x
//           ────────────────────────────────────────────────────────  × 100
//                Σ outstandingPrincipal of the collectible book
//
// This is now genuinely the single definition: the same `COLLECTIBLE_STATUSES`
// backs /dashboard, /collections, the board pack, the reports overview, the
// spreadsheet exports and the NCR quarterly return. See
// lib/loan/collectible-book.ts for what is in the book and why.
//
// It did not used to be. This module computed PAR over ACTIVE only while the
// reports overview and the NCR return used a wider population, so the business
// reported one PAR number to itself and a different one to the regulator — and
// this comment claimed they were the same. The old ACTIVE-only reasoning was
// that a settled-but-defaulted loan (~R0 outstanding) contributes ~0 anyway;
// that is true, and it is also an argument for including it, since a
// value-weighted ratio is unmoved by a zero-balance account either way. What
// the exclusion did move was the accounts that still owe money: DEFAULTED and
// PENDING_WRITE_OFF loans vanished from both numerator and denominator, which
// understated the book.
//
// Numerator and denominator share one population by construction here, so the
// ratio cannot exceed 100% — the defect that originally motivated the guard.

export interface ParBucket {
  /** Number of collectible loans at or beyond this DPD threshold. */
  count: number
  /** Outstanding principal (cents) of those loans. */
  value: number
  /** Value share of the collectible book, as a percentage. */
  pct: number
}

export interface PortfolioPar {
  /** Total outstanding principal of the collectible book (cents). */
  book: number
  par30: ParBucket
  par60: ParBucket
  par90: ParBucket
}

type Agg = { _count: number; _sum: { outstandingPrincipal: number | null } }

export async function getPortfolioPar(tenantId: string): Promise<PortfolioPar> {
  const [bookAgg, p30, p60, p90] = await Promise.all([
    prisma.loan.aggregate({ where: collectibleLoanWhere(tenantId), _sum: { outstandingPrincipal: true } }),
    prisma.loan.aggregate({ where: collectibleParWhere(tenantId, 30), _count: true, _sum: { outstandingPrincipal: true } }),
    prisma.loan.aggregate({ where: collectibleParWhere(tenantId, 60), _count: true, _sum: { outstandingPrincipal: true } }),
    prisma.loan.aggregate({ where: collectibleParWhere(tenantId, 90), _count: true, _sum: { outstandingPrincipal: true } }),
  ])

  const book = Number(bookAgg._sum.outstandingPrincipal ?? 0)
  const toBucket = (agg: Agg): ParBucket => {
    const value = Number(agg._sum.outstandingPrincipal ?? 0)
    return { count: agg._count, value, pct: book > 0 ? (value / book) * 100 : 0 }
  }

  return { book, par30: toBucket(p30), par60: toBucket(p60), par90: toBucket(p90) }
}
