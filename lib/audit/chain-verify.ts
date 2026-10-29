/**
 * Walks the AuditLog hash chains and reports the first broken link of each.
 *
 * The hash itself is public.audit_log_row_hash (migration 20261029100000), the
 * same function the AuditLog_zz_chain trigger writes with, so a row is checked
 * against the one definition. Reads only. A chain is the rows of one tenant, or
 * (key "") the rows with none.
 */
import type { PrismaClient } from "@prisma/client"

export const GENESIS_HASH = "0".repeat(64)
const PAGE = 5000
const MAX_SEQ = 2_147_483_647

export type ChainBreakKind =
  | "seq_gap" // chainSeq is not the previous one + 1: a row is missing or inserted
  | "prev_hash_mismatch" // prevHash is not the previous row's rowHash
  | "row_hash_mismatch" // the stored rowHash is not the hash of the row's content
  | "unchained_row" // a row with no chain columns: written with the trigger off
  | "head_missing" // rows exist but the chain's head row is gone
  | "head_mismatch" // the head names another last row: the tail was cut or the head edited

export interface ChainBreak {
  /** The tenant id, "" for the platform chain. */
  chainKey: string
  kind: ChainBreakKind
  /** The row where the walk first failed; null for a head fault. */
  auditLogId: string | null
  chainSeq: number | null
  detail: string
}

export interface ChainVerification {
  ok: boolean
  chains: number
  rowsChecked: number
  /** One entry per broken chain: where its walk first failed. */
  breaks: ChainBreak[]
}

type Db = Pick<PrismaClient, "$queryRaw">

interface ChainRow { id: string; chainSeq: number; prevHash: string; rowHash: string; computed: string }
interface HeadRow { lastSeq: number; lastHash: string }

async function chainKeys(db: Db, only?: string): Promise<string[]> {
  if (only !== undefined) return [only]
  const rows = await db.$queryRaw<Array<{ k: string }>>`
    SELECT "chainKey" AS k FROM "AuditChainHead"
    UNION SELECT "id" FROM "Tenant"
    UNION SELECT ''
    ORDER BY k`
  return rows.map((r) => r.k)
}

async function page(db: Db, key: string, afterSeq: number, upTo: number): Promise<ChainRow[]> {
  return db.$queryRaw<ChainRow[]>`
    SELECT a."id", a."chainSeq", a."prevHash", a."rowHash", public.audit_log_row_hash(a) AS computed
    FROM "AuditLog" a
    WHERE COALESCE(a."tenantId", '') = ${key} AND a."chainSeq" > ${afterSeq} AND a."chainSeq" <= ${upTo}
    ORDER BY a."chainSeq" LIMIT ${PAGE}`
}

/** Verifies one chain. Returns its first break (or null) and how many rows it read. */
async function verifyChain(db: Db, key: string): Promise<{ broken: ChainBreak | null; rows: number }> {
  // The head is read first and the walk stops at its seq: a row committed
  // while this runs is past it, and the head and the row commit together.
  const [head] = await db.$queryRaw<HeadRow[]>`SELECT "lastSeq", "lastHash" FROM "AuditChainHead" WHERE "chainKey" = ${key}`
  const upTo = head?.lastSeq ?? MAX_SEQ
  let seq = 0
  let hash = GENESIS_HASH
  let rows = 0
  const row = (r: ChainRow, kind: ChainBreakKind, detail: string): ChainBreak =>
    ({ chainKey: key, kind, auditLogId: r.id, chainSeq: r.chainSeq, detail })

  for (;;) {
    const batch = await page(db, key, seq, upTo)
    if (batch.length === 0) break
    for (const r of batch) {
      rows++
      if (r.chainSeq !== seq + 1) return { broken: row(r, "seq_gap", `expected seq ${seq + 1}, found ${r.chainSeq}`), rows }
      if (r.prevHash !== hash) return { broken: row(r, "prev_hash_mismatch", "prevHash does not match the previous row's rowHash"), rows }
      if (r.rowHash !== r.computed) return { broken: row(r, "row_hash_mismatch", "the row's content no longer hashes to its rowHash"), rows }
      seq = r.chainSeq
      hash = r.rowHash
    }
  }

  const [loose] = await db.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AuditLog"
    WHERE COALESCE("tenantId", '') = ${key} AND ("chainSeq" IS NULL OR "prevHash" IS NULL OR "rowHash" IS NULL)
    ORDER BY "createdAt", "id" LIMIT 1`
  if (loose) {
    return { broken: { chainKey: key, kind: "unchained_row", auditLogId: loose.id, chainSeq: null, detail: "a row has no chain columns" }, rows }
  }

  if (!head) {
    return seq === 0
      ? { broken: null, rows }
      : { broken: { chainKey: key, kind: "head_missing", auditLogId: null, chainSeq: null, detail: `${seq} rows but no chain head` }, rows }
  }
  if (head.lastSeq !== seq || head.lastHash !== hash) {
    return {
      broken: { chainKey: key, kind: "head_mismatch", auditLogId: null, chainSeq: seq, detail: `head records seq ${head.lastSeq}, the table ends at seq ${seq}` },
      rows,
    }
  }
  return { broken: null, rows }
}

/**
 * Verifies every chain, or only `chainKey` (a tenant id; "" for the platform
 * chain). A tenant with no audit rows has no chain and passes.
 */
export async function verifyAuditChains(db: Db, opts: { chainKey?: string } = {}): Promise<ChainVerification> {
  const keys = await chainKeys(db, opts.chainKey)
  const breaks: ChainBreak[] = []
  let rowsChecked = 0
  for (const key of keys) {
    const { broken, rows } = await verifyChain(db, key)
    rowsChecked += rows
    if (broken) breaks.push(broken)
  }
  return { ok: breaks.length === 0, chains: keys.length, rowsChecked, breaks }
}
