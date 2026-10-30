/**
 * The chainer: appends one AuditChainLink for every COMMITTED AuditLog row that
 * has none, in (createdAt, id) order within a chain.
 *
 * Why not a trigger: a chain is one serial history, and inserting into it from
 * every audited transaction made them all wait on each other, raised 40001 in
 * Serializable ones, and gave a rolled-back or ON CONFLICT-skipped insert a
 * phantom link. Here an AuditLog insert touches no chain; a row that never
 * committed is never seen; and the order of a chain is the order the chainer
 * observed rows commit (a transaction that started early and committed late is
 * simply linked later).
 *
 * Finding the unlinked rows has no wall-clock window. A chain has a high-water mark (the
 * newest createdAt among its last 1000 linked rows; an insert's createdAt is the database
 * clock, set by a trigger), and a SHALLOW pass looks at rows after the mark less a margin (never
 * further back than the 5000th newest link): an outage of any length just resumes from the mark,
 * and a backfill proceeds from the mark, not from the start. A row that committed long after it was
 * made (a long transaction) sits behind the mark; the DEEP pass (the last seven days; at boot and
 * hourly) finds it, and the FULL sweep (no floor; the daily job) finds anything.
 *
 * One chainer works a chain at a time: audit_chain_lock, a FOR UPDATE SKIP LOCKED row only that
 * function touches (a second replica skips the chain), taken first in the transaction that reads
 * the head and inserts the links. (Not an advisory lock: any login could take one to starve it.) The links go in through audit_chain_append
 * (lib/audit/store.ts): the application's roles have no privilege on the table, and
 * the function refuses a link that does not continue the chain. Only the worker, which
 * holds AUDIT_CHAIN_KEY, runs it.
 */
import type { Prisma, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { logger } from "@/lib/observability/logger"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { GENESIS_HASH, linkHash } from "./chain-hash"
import { appendLinks, candidateChains, chainHead, lockChain, unlinkedRows, type NewLink, type ScanMode } from "./store"

export const BATCH = 500
/** A pass looks this far behind a chain's high-water mark; a commit later than this waits for the deep pass. */
export const MARGIN_SECONDS = 3600
/** An unlinked row older than this is a break the verifier reports (the deep pass runs far more often). */
export const UNCHAINED_GRACE_MS = 24 * 3_600_000
const DEEP_EVERY_MS = 3_600_000
/** A chain another chainer has held this many passes in a row is reported. */
export const BUSY_ALERT_PASSES = 12

export interface ChainerResult {
  chains: number
  linked: number
  /** Chains another chainer held. */
  busy: number
  /** Chains whose pass failed (logged); the others went on. */
  failed: number
}

let lastDeepScan = 0
const busyStreak = new Map<string, number>()

type Tx = Prisma.TransactionClient

/** Links up to BATCH rows of one chain. Returns the rows linked, or null if another chainer holds the chain. */
async function chainBatch(db: PrismaClient, key: string, mode: ScanMode, limit: number): Promise<number | null> {
  return db.$transaction(async (tx: Tx) => {
    if (!(await lockChain(tx, key))) return null

    const head = await chainHead(tx, key)
    const rows = await unlinkedRows(tx, key, mode, MARGIN_SECONDS, limit)
    if (rows.length === 0) return 0

    let seq = head?.seq ?? 0
    let prev = head?.rowHash ?? GENESIS_HASH
    const links: NewLink[] = rows.map((row) => {
      seq += 1
      const rowHash = linkHash(key, seq, prev, row)
      const link = { seq, auditLogId: row.auditLogId, prevHash: prev, rowHash }
      prev = rowHash
      return link
    })
    return appendLinks(tx, key, links)
  }, { timeout: 60_000 })
}

/**
 * One batch with the size halved after each failure (a timeout on rows that are slow to hash, say) down to a single
 * row, so a heavy row costs its own chain time and nothing more. Returns what chainBatch does; throws only if a
 * batch of one row fails too.
 */
export async function chainBatchAdaptive(db: PrismaClient, key: string, mode: ScanMode, start: number = BATCH): Promise<{ linked: number | null; size: number }> {
  let size = start
  for (;;) {
    try {
      return { linked: await chainBatch(db, key, mode, size), size }
    } catch (error) {
      if (size <= 1) throw error
      size = Math.max(1, Math.floor(size / 2))
      logger.warn("[audit-chainer] a batch failed; trying a smaller one", { chainKey: key, size, error })
    }
  }
}

/** Counts the passes in a row a chain was held by another chainer, and says so once it has been too many. */
export function noteBusy(key: string, busy: boolean): void {
  if (!busy) { busyStreak.delete(key); return }
  const n = (busyStreak.get(key) ?? 0) + 1
  busyStreak.set(key, n)
  if (n === BUSY_ALERT_PASSES) logger.error("[audit-chainer] a chain has been held by another chainer for many passes", { chainKey: key, passes: n })
}

/**
 * One pass over every chain with committed, unchained rows (or only the chains in `only`: for a test sharing
 * a database). `mode` is where it looks (shallow, deep, full: see above); by default deep at the first pass of
 * the process and then hourly, shallow otherwise.
 */
export async function runChainer(opts: { db?: PrismaClient; mode?: ScanMode; budgetMs?: number; only?: readonly string[] } = {}): Promise<ChainerResult> {
  const db = (opts.db ?? prisma) as unknown as PrismaClient
  const started = Date.now()
  const dueDeep = Date.now() - lastDeepScan >= DEEP_EVERY_MS
  const mode: ScanMode = opts.mode ?? (dueDeep ? "deep" : "shallow")
  if (mode !== "shallow") lastDeepScan = Date.now()
  const result: ChainerResult = { chains: 0, linked: 0, busy: 0, failed: 0 }

  return withoutTenantScope(async () => {
    const keys = (await candidateChains(db, mode, MARGIN_SECONDS)).sort().filter((k) => !opts.only || opts.only.includes(k))
    for (const key of keys) {
      result.chains++
      // One chain's failure is that chain's: every other lender is still chained.
      try {
        let size = BATCH
        for (;;) {
          const { linked, size: used } = await chainBatchAdaptive(db, key, mode, size)
          size = used
          noteBusy(key, linked === null)
          if (linked === null) { result.busy++; break }
          result.linked += linked
          if (linked < size || Date.now() - started > (opts.budgetMs ?? 45_000)) break
        }
      } catch (error) {
        result.failed++
        logger.error("[audit-chainer] a chain could not be chained; the others go on", { chainKey: key, error })
      }
    }
    return result
  })
}

/** Passes every `intervalMs` for `durationMs`: what the once-a-minute cron route runs, so a row waits seconds, not a minute. */
export async function runChainerFor(durationMs: number, intervalMs: number, opts: { db?: PrismaClient } = {}): Promise<ChainerResult> {
  const total: ChainerResult = { chains: 0, linked: 0, busy: 0, failed: 0 }
  const end = Date.now() + durationMs
  for (;;) {
    const r = await runChainer(opts)
    total.chains += r.chains; total.linked += r.linked; total.busy += r.busy; total.failed += r.failed
    if (Date.now() + intervalMs >= end) break
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return total
}
