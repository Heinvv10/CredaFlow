import type { prisma } from "@/lib/prisma"
import { COLLECTIBLE_STATUSES, collectibleLoanWhere } from "@/lib/loan/collectible-book"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { syncLoanCharges } from "@/lib/loan/charges-sync"

// Re-syncs default charges across a tenant's collectible book, one loan per
// transaction: the nightly cron and the back-fill --apply both run through
// here. ALL money is CENTS.

export type SweepDb = Pick<typeof prisma, "$transaction" | "loan">

export interface SweepResult {
  loans: number
  changed: number
  /** loans whose sync threw; every other loan was still swept */
  failures: Array<{ loanId: string; error: string }>
}

/** The collectible book, in id order: every loan the sweep and the back-fill re-derive. */
export async function sweepLoanIds(db: Pick<typeof prisma, "loan">, tenantId: string): Promise<string[]> {
  // The same book the DPD cron refreshes: ACTIVE, DEFAULTED,
  // PENDING_WRITE_OFF, RESTRUCTURED (lib/loan/collectible-book.ts).
  const book = await db.loan.findMany({ where: collectibleLoanWhere(tenantId), orderBy: { id: "asc" }, select: { id: true } })
  return book.map((loan) => loan.id)
}

export async function sweepTenantCharges(
  db: SweepDb,
  tenantId: string,
  asOf: Date,
  actor: { source: string; userId?: string | null; userEmail?: string | null },
  /**
   * `accepted`: the back-fill's plan-time set of loans staff accepted a
   * lowered totalPaid or re-open for; only those may change that way here.
   */
  options: { accepted?: ReadonlySet<string> } = {},
): Promise<SweepResult> {
  const ids = await sweepLoanIds(db, tenantId)
  const result: SweepResult = { loans: ids.length, changed: 0, failures: [] }
  for (const id of ids) {
    try {
      const synced = await db.$transaction(async (tx) => {
        await lockLoanForUpdate(tx, id)
        // The listing is not locked: a loan settled, written off or cancelled
        // since then is left alone.
        const current = await tx.loan.findUnique({ where: { id, tenantId }, select: { status: true } })
        if (!current || !(COLLECTIBLE_STATUSES as readonly string[]).includes(current.status)) return null
        const outcome = await syncLoanCharges(tx, { tenantId, loanId: id }, asOf, actor,
          options.accepted ? { mode: "backfill", accepted: options.accepted } : {})
        // Deferred guards would otherwise fail at COMMIT, outside this catch's
        // view of which loan broke.
        await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
        return outcome
      })
      if (synced?.changed) result.changed++
    } catch (error) {
      // One loan's failure must not stop the book; it is reported, and the
      // caller turns any failure into a non-2xx / non-zero exit.
      result.failures.push({ loanId: id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
