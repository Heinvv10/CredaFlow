/**
 * The collectible book — the ONE definition of "loans still owed to us", used
 * by every reporting surface: the executive dashboard, collections, the reports
 * overview, the board pack, the spreadsheet exports and the NCR quarterly
 * return.
 *
 * It lives here rather than beside any one consumer because it is not a
 * compliance concept or a reports concept; it is a property of the loan book.
 * (It previously lived in `lib/compliance/ncr-return.ts`, which meant the
 * executive dashboard had to import a compliance module to know what a book is.)
 *
 * WHY ONE DEFINITION. Before this, PAR meant two different things depending on
 * which screen you were on: `lib/reports/par.ts` computed it over ACTIVE only
 * and backed /dashboard, /collections and the board pack, while the reports
 * overview and the NCR return used ACTIVE + DEFAULTED. Both had been separately
 * audited, with contradictory reasoning, and `par.ts` opened by declaring
 * itself "the SINGLE definition used across the dashboard, collections, reports
 * and the NCR return" — which was false. The business reported one PAR number
 * to itself and a different one to the regulator.
 *
 * INCLUDED
 *   ACTIVE             — performing or in arrears, still owed.
 *   DEFAULTED          — still owed; the debt has not been forgiven.
 *   PENDING_WRITE_OFF  — parked awaiting write-off approval by
 *                        app/api/loans/[id]/write-off/route.ts. Still owed: it
 *                        has NOT been written off, and it is not in the
 *                        write-off line either. Excluding it put such a loan in
 *                        no figure at all.
 *   RESTRUCTURED       — treated as a live loan by lib/portal/loan-overview.ts.
 *                        Currently inert: nothing in the codebase writes it.
 *
 * EXCLUDED
 *   COMPLETED, CANCELLED — nothing owed.
 *   WRITTEN_OFF          — the debt has been given up, and it has its own
 *                          reporting line. It also RETAINS its last
 *                          `daysInArrears` / `arrearsAmount` (the write-off
 *                          route does not reset them), so including it would
 *                          double-count against that line and inflate arrears
 *                          for ever.
 *
 * ⚠️ KNOWN STALENESS. `app/api/cron/dpd-update/route.ts` refreshes
 * `daysInArrears` / `arrearsAmount` for ACTIVE + DEFAULTED only, so a
 * PENDING_WRITE_OFF loan carries the ageing it had when it entered the queue.
 * Its outstanding principal is still real money at risk — which is why it
 * belongs in the book — but its DPD band can be stale. Do NOT "fix" this by
 * adding PENDING_WRITE_OFF to that cron's population: the same job promotes
 * anything at 90+ DPD to DEFAULTED, which would silently pull loans back out
 * of the write-off approval queue.
 */

import type { Prisma } from "@prisma/client"

export const COLLECTIBLE_STATUSES = [
  "ACTIVE",
  "DEFAULTED",
  "PENDING_WRITE_OFF",
  "RESTRUCTURED",
] as const

/** Statuses deliberately outside the book, kept explicit so the split is total. */
export const SETTLED_STATUSES = ["COMPLETED", "CANCELLED", "WRITTEN_OFF"] as const

/** `where` fragment for the collectible book of one tenant. */
export function collectibleLoanWhere(tenantId: string): Prisma.LoanWhereInput {
  return { tenantId, status: { in: [...COLLECTIBLE_STATUSES] } }
}

/** The collectible book, narrowed to accounts at or beyond `minDays` past due. */
export function collectibleParWhere(tenantId: string, minDays: number): Prisma.LoanWhereInput {
  return { ...collectibleLoanWhere(tenantId), daysInArrears: { gte: minDays } }
}
