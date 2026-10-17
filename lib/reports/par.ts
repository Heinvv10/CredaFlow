import { getBookArrears, type ParBand } from "@/lib/reports/book-arrears"

// Portfolio-at-Risk — VALUE-WEIGHTED, over the COLLECTIBLE BOOK.
//
//   PARx% = Σ outstandingPrincipal of loans in arrears with DPD >= x
//           ─────────────────────────────────────────────────────────  × 100
//                Σ outstandingPrincipal of the collectible book
//
// The definition lives in lib/reports/book-arrears.ts, which the dashboard,
// collections, the sidebar badge and the NCR return all read. This is the
// board pack's view of the same numbers, kept so its callers are unchanged.

export type ParBucket = ParBand

export interface PortfolioPar {
  /** Total outstanding principal of the collectible book (cents). */
  book: number
  par30: ParBucket
  par60: ParBucket
  par90: ParBucket
}

export async function getPortfolioPar(tenantId: string): Promise<PortfolioPar> {
  const { book, par30, par60, par90 } = await getBookArrears(tenantId)
  return { book: book.value, par30, par60, par90 }
}
