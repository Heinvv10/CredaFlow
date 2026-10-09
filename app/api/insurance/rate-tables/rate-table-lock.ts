// app/api/insurance/rate-tables/rate-table-lock.ts
//
// Row locks that serialise the rate-card writes which have no database
// constraint behind them.
//
// ⚠️ THE INVARIANTS BELOW ARE ENFORCED IN APPLICATION CODE ONLY. The schema is
// frozen for this phase, so there is no partial unique index asserting "at most
// one ACTIVE rate table per product" and no exclusion constraint asserting
// "no two bands overlap". Those are the structural fixes and they are
// deliberately deferred — which means these locks are the ONLY thing standing
// between a concurrent operator and an unquotable product. A future migration
// adding `CREATE UNIQUE INDEX … ON "InsuranceRateTable" ("tenantId",
// "productId") WHERE "status" = 'ACTIVE'` would make the D4 guard belt-and-
// braces rather than sole.
//
// Why an explicit `SELECT … FOR UPDATE` rather than
// `isolationLevel: Serializable`:
//
//   - Serializable turns a lost race into a 40001 serialisation failure, which
//     Prisma surfaces as P2034 and which every caller then has to retry. These
//     are rare, operator-driven clicks; making the second one BLOCK for a few
//     milliseconds and then succeed (or get a truthful 409) is strictly better
//     than making it fail with an error that means "try again".
//   - The lock is one mechanism that covers both defects. Activation locks the
//     product row; band writes lock the parent rate-table row. Both are cheap,
//     both are explicit at the call site, and neither depends on the reviewer
//     reasoning about predicate locks and read sets to see why it holds.
//
// ⚠️ LOCK ORDERING — THE PRODUCT LOCK IS ALWAYS TAKEN BEFORE THE TABLE LOCK.
//
// An earlier version of this note claimed the two locks are never taken
// together and that there was therefore no ordering to preserve. That was the
// reasoning error behind a real defect: because they lock DIFFERENT rows, they
// did not exclude each other AT ALL, and a band delete could commit between
// activation's band count and its update. Activation would then commit an empty
// table as ACTIVE having already retired the card that was live, dropping the
// product to NO_BANDS with nothing to fall back to.
//
// Activation now takes BOTH: the product row first, then the rate-table row it
// is activating. Every other path (band create, band update, band delete, and
// the basis re-validation on PATCH) takes the TABLE lock only. So the
// product→table order is the only order in which both are ever held, and no
// cycle exists. Any future path that needs both MUST take them in that order.

import { Prisma } from "@prisma/client"
import type { RateBasis, RateTableStatus } from "@prisma/client"
import type { prisma as ScopedPrismaClient } from "@/lib/prisma"

/** The transaction client `prisma.$transaction(fn)` hands to its callback. */
export type RateTableTransaction = Parameters<
  Parameters<typeof ScopedPrismaClient.$transaction>[0]
>[0]

export interface LockedRateTable {
  id: string
  status: RateTableStatus
  productId: string
  /**
   * Read under the lock deliberately. `basis` decides which bands collide, so a
   * PATCH changing it concurrently with a band insert would otherwise have the
   * overlap check applying one rule while the row ends up under another.
   */
  basis: RateBasis
}

/**
 * Take a row-exclusive lock on ONE rate table and return its CURRENT state.
 *
 * This is the guard for every band write, and — since the concurrency defect
 * described in the header — the second lock activation takes. Two things fall
 * out of it:
 *
 *   1. Concurrent band writers on the same table serialise, so the overlap
 *      check and the insert that follows it cannot interleave. Without this,
 *      two POSTs for ages 18–30 and 25–40 both see no overlap (neither has
 *      committed) and both insert — and the unique index does NOT catch it,
 *      because the tuples differ. The table then prices age 27 two ways and
 *      `resolveActiveRateTable` reports AMBIGUOUS_ACTIVE_TABLES rather than a
 *      price, so the product becomes unquotable.
 *   2. The status returned here is read UNDER the lock, so "the parent is
 *      still DRAFT" is true for the rest of the transaction. A concurrent
 *      activate has to take the same row lock to run its own UPDATE, so it
 *      either committed before this read (status comes back ACTIVE → 409) or
 *      it waits until this transaction commits.
 *
 * Returns null when no such row exists for this tenant — the 404 case. The
 * tenant is in the WHERE clause because `InsuranceRateBand` has no tenantId of
 * its own and is reached only through its table.
 */
export async function lockRateTable(
  tx: RateTableTransaction,
  args: { id: string; tenantId: string },
): Promise<LockedRateTable | null> {
  const rows = await tx.$queryRaw<LockedRateTable[]>(Prisma.sql`
    SELECT "id", "status", "productId", "basis"
    FROM "InsuranceRateTable"
    WHERE "id" = ${args.id} AND "tenantId" = ${args.tenantId}
    FOR UPDATE
  `)
  return rows[0] ?? null
}

/**
 * Take a row-exclusive lock on the PRODUCT, serialising every activation for
 * it. Must be the first statement in the activation transaction.
 *
 * The bug this closes needs two DIFFERENT drafts, which is why re-reading the
 * table being activated is not enough. Under READ COMMITTED, with drafts A and
 * B and a live table C: T1 flips C→RETIRED and A→ACTIVE but has not committed;
 * T2 reads B as DRAFT (T1 never touched it), and its own
 * `updateMany(status: ACTIVE)` cannot see A — still DRAFT in T2's snapshot —
 * so it blocks on C alone. When T1 commits, T2 re-evaluates C, finds it
 * RETIRED, matches nothing, and cheerfully sets B ACTIVE. Both A and B are now
 * ACTIVE for the same product, and every quote against it fails.
 *
 * Locking the product first makes T2 wait for T1 to commit BEFORE it reads
 * anything, at which point its retire step sees A as the live table and
 * retires it properly.
 *
 * Returns FALSE when no such product row exists for this tenant. `SELECT …
 * FOR UPDATE` matching zero rows takes no lock and raises nothing, so a caller
 * that discarded this would carry on with its serialisation guard silently
 * absent. The caller must treat false as a 404, not as a lock.
 *
 * This is the FIRST of the two locks activation takes; see the ordering note in
 * the header before adding a third caller.
 */
export async function lockProductForActivation(
  tx: RateTableTransaction,
  args: { productId: string; tenantId: string },
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"
    FROM "InsuranceProduct"
    WHERE "id" = ${args.productId} AND "tenantId" = ${args.tenantId}
    FOR UPDATE
  `)
  return Boolean(rows[0])
}
