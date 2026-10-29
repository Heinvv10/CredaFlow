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
 * clock, set by a trigger), and a pass looks at rows after the mark less a margin: an outage of
 * any length just resumes from the mark, and a backfill proceeds from the mark, not from the
 * start. A row that committed more than the margin after it was made (a long transaction) sits
 * behind the mark; the DEEP pass (no floor) finds it, at boot, hourly and in the daily job.
 *
 * One chainer works a chain at a time: pg_try_advisory_xact_lock per chain key
 * (a second replica skips that chain), taken in the same transaction that reads
 * the head and inserts the links. The links go in through audit_chain_append
 * (lib/audit/store.ts): the application's roles have no privilege on the table, and
 * the function refuses a link that does not continue the chain. Only the worker, which
 * holds AUDIT_CHAIN_KEY, runs it.
 */
import type { Prisma, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { logger } from "@/lib/observability/logger"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { GENESIS_HASH, linkHash } from "./chain-hash"
import { appendLinks, candidateChains, chainHead, unlinkedRows, type NewLink } from "./store"

export const BATCH = 500
/** A pass looks this far behind a chain's high-water mark; a commit later than this waits for the deep pass. */
export const MARGIN_SECONDS = 3600
/** An unlinked row older than this is a break the verifier reports (the deep pass runs far more often). */
export const UNCHAINED_GRACE_MS = 24 * 3_600_000
const DEEP_EVERY_MS = 3_600_000
/** A chain another chainer has held this many passes in a row is reported. */
const BUSY_ALERT_PASSES = 12

export interface ChainerResult {
  chains: number
  linked: number
  /** Chains another chainer held. */
  busy: number
}

let lastDeepScan = 0
const busyStreak = new Map<string, number>()

type Tx = Prisma.TransactionClient

/** Links up to BATCH rows of one chain. Returns the rows linked, or null if another chainer holds the chain. */
async function chainBatch(db: PrismaClient, key: string, deep: boolean): Promise<number | null> {
  return db.$transaction(async (tx: Tx) => {
    const [lock] = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`audit-chain:${key}`}, 0)) AS ok`
    if (!lock.ok) return null

    const head = await chainHead(tx, key)
    const rows = await unlinkedRows(tx, key, deep, MARGIN_SECONDS, BATCH)
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

function noteBusy(key: string, busy: boolean): void {
  if (!busy) { busyStreak.delete(key); return }
  const n = (busyStreak.get(key) ?? 0) + 1
  busyStreak.set(key, n)
  if (n === BUSY_ALERT_PASSES) logger.error("[audit-chainer] a chain has been held by another chainer for many passes", { chainKey: key, passes: n })
}

/**
 * One pass over every chain with committed, unchained rows (or only the chains in `only`: for a
 * test sharing a database). `deep` looks at every row with no link; by default it is deep at the
 * first pass of the process and then hourly.
 */
export async function runChainer(opts: { db?: PrismaClient; deep?: boolean; budgetMs?: number; only?: readonly string[] } = {}): Promise<ChainerResult> {
  const db = (opts.db ?? prisma) as unknown as PrismaClient
  const started = Date.now()
  const deep = opts.deep ?? (Date.now() - lastDeepScan >= DEEP_EVERY_MS)
  if (deep) lastDeepScan = Date.now()
  const result: ChainerResult = { chains: 0, linked: 0, busy: 0 }

  return withoutTenantScope(async () => {
    const keys = (await candidateChains(db, deep, MARGIN_SECONDS)).sort().filter((k) => !opts.only || opts.only.includes(k))
    for (const key of keys) {
      result.chains++
      for (;;) {
        const n = await chainBatch(db, key, deep)
        noteBusy(key, n === null)
        if (n === null) { result.busy++; break }
        result.linked += n
        if (n < BATCH || Date.now() - started > (opts.budgetMs ?? 45_000)) break
      }
    }
    return result
  })
}

/** Passes every `intervalMs` for `durationMs`: what the once-a-minute cron route runs, so a row waits seconds, not a minute. */
export async function runChainerFor(durationMs: number, intervalMs: number, opts: { db?: PrismaClient } = {}): Promise<ChainerResult> {
  const total: ChainerResult = { chains: 0, linked: 0, busy: 0 }
  const end = Date.now() + durationMs
  for (;;) {
    const r = await runChainer(opts)
    total.chains += r.chains; total.linked += r.linked; total.busy += r.busy
    if (Date.now() + intervalMs >= end) break
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return total
}
