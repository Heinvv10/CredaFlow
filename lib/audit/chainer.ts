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
 * the head and inserts the links.
 */
import { Prisma, type PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { chainRows, GENESIS_HASH, linkHash, PLATFORM_CHAIN, ROW_FIELDS_SQL, type HashedRow } from "./chain-hash"

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

async function candidateChains(db: PrismaClient, now: Date, deep: boolean): Promise<string[]> {
  const since = new Date(now.getTime() - (deep ? LOOKBACK_MS : RECENT_MS))
  const recent = await db.$queryRaw<Array<{ k: string }>>`
    SELECT DISTINCT COALESCE(a."tenantId", '') AS k FROM "AuditLog" a
    WHERE a."createdAt" >= ${since}
      AND NOT EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."auditLogId" = a."id")`
  // A chain with no link yet is chained from its first row, however old.
  const fresh = await db.$queryRaw<Array<{ k: string }>>`
    SELECT t."id" AS k FROM "Tenant" t
    WHERE NOT EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."chainKey" = t."id")
      AND EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."tenantId" = t."id")
    UNION
    SELECT '' WHERE NOT EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."chainKey" = '')
      AND EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."tenantId" IS NULL)`
  return [...new Set([...recent, ...fresh].map((r) => r.k))].sort()
}

type Tx = Prisma.TransactionClient

/** Links up to BATCH rows of one chain. Returns the rows linked, or null if another chainer holds the chain. */
async function chainBatch(db: PrismaClient, key: string, now: Date): Promise<number | null> {
  return db.$transaction(async (tx: Tx) => {
    const [lock] = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`audit-chain:${key}`}, 0)) AS ok`
    if (!lock.ok) return null

    const [head] = await tx.$queryRaw<Array<{ seq: number; rowHash: string }>>`
      SELECT "seq", "rowHash" FROM "AuditChainLink" WHERE "chainKey" = ${key} ORDER BY "seq" DESC LIMIT 1`
    const window = head ? Prisma.sql`AND a."createdAt" >= ${new Date(now.getTime() - LOOKBACK_MS)}` : Prisma.empty
    const rows = await tx.$queryRaw<HashedRow[]>(Prisma.sql`
      SELECT ${ROW_FIELDS_SQL} FROM "AuditLog" a
      WHERE ${chainRows(key)} ${window}
        AND NOT EXISTS (SELECT 1 FROM "AuditChainLink" l WHERE l."auditLogId" = a."id")
      ORDER BY a."createdAt", a."id" LIMIT ${BATCH}`)
    if (rows.length === 0) return 0

    let seq = head?.seq ?? 0
    let prev = head?.rowHash ?? GENESIS_HASH
    const links = rows.map((row) => {
      seq += 1
      const rowHash = linkHash(key, seq, prev, row)
      const link = { seq, auditLogId: row.auditLogId, prevHash: prev, rowHash }
      prev = rowHash
      return link
    })
    const tenantId = key === PLATFORM_CHAIN ? null : key
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "AuditChainLink" ("chainKey", "seq", "auditLogId", "tenantId", "prevHash", "rowHash")
      VALUES ${Prisma.join(links.map((l) => Prisma.sql`(${key}, ${l.seq}, ${l.auditLogId}, ${tenantId}, ${l.prevHash}, ${l.rowHash})`))}`)

    if (tenantId) {
      const [policy] = await tx.$queryRaw<Array<{ on: boolean }>>`SELECT "siemEnabled" AS "on" FROM "AuditPolicy" WHERE "tenantId" = ${tenantId}`
      if (policy?.on) {
        // ON CONFLICT: a policy-change row may already be queued for its old destination.
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "AuditSiemOutbox" ("tenantId", "kind", "auditLogId", "seq")
          VALUES ${Prisma.join(links.map((l) => Prisma.sql`(${tenantId}, 'EVENT', ${l.auditLogId}, ${l.seq})`))}
          ON CONFLICT ("auditLogId") DO NOTHING`)
      }
    }
    return links.length
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
    const keys = (await candidateChains(db, now, deep)).filter((k) => !opts.only || opts.only.includes(k))
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
