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
 * One chainer works a chain at a time: pg_try_advisory_xact_lock per chain key
 * (a second replica skips that chain), taken in the same transaction that reads
 * the head and inserts the links. The links go in through audit_chain_append
 * (lib/audit/store.ts): the application's role has no privilege on the table, and
 * the function refuses a link that does not continue the chain.
 */
import type { Prisma, PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { GENESIS_HASH, linkHash } from "./chain-hash"
import { appendLinks, candidateChains, chainHead, unlinkedRows, type NewLink } from "./store"

export const BATCH = 500
/** An unchained row older than this is not the chainer's to find; the verifier reports it. */
export const LOOKBACK_MS = 24 * 3_600_000
const RECENT_MS = 15 * 60_000
const DEEP_EVERY_MS = 5 * 60_000

export interface ChainerResult {
  chains: number
  linked: number
  /** Chains another chainer held. */
  busy: number
}

let lastDeepScan = 0

type Tx = Prisma.TransactionClient

/** Links up to BATCH rows of one chain. Returns the rows linked, or null if another chainer holds the chain. */
async function chainBatch(db: PrismaClient, key: string, now: Date): Promise<number | null> {
  return db.$transaction(async (tx: Tx) => {
    const [lock] = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`audit-chain:${key}`}, 0)) AS ok`
    if (!lock.ok) return null

    const head = await chainHead(tx, key)
    const rows = await unlinkedRows(tx, key, head ? new Date(now.getTime() - LOOKBACK_MS) : null, BATCH)
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

/** One pass over every chain with committed, unchained rows (or only the chains in `only`: for a test sharing a database). */
export async function runChainer(opts: { db?: PrismaClient; now?: Date; deep?: boolean; budgetMs?: number; only?: readonly string[] } = {}): Promise<ChainerResult> {
  const db = (opts.db ?? prisma) as unknown as PrismaClient
  const now = opts.now ?? new Date()
  const started = Date.now()
  const deep = opts.deep ?? (Date.now() - lastDeepScan >= DEEP_EVERY_MS)
  if (deep) lastDeepScan = Date.now()
  const result: ChainerResult = { chains: 0, linked: 0, busy: 0 }

  return withoutTenantScope(async () => {
    const since = new Date(now.getTime() - (deep ? LOOKBACK_MS : RECENT_MS))
    const keys = (await candidateChains(db, since)).sort().filter((k) => !opts.only || opts.only.includes(k))
    for (const key of keys) {
      result.chains++
      for (;;) {
        const n = await chainBatch(db, key, now)
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
