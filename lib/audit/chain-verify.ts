/**
 * Walks the AuditLog hash chains and reports the first broken link of each.
 *
 * `full` walks every link from the genesis; `incremental` starts at the chain's
 * latest checkpoint (after proving the checkpoint's HMAC and that the link it
 * names still has that hash), which is what the daily job and the admin endpoint
 * run. Reads only, through the database's verification functions (lib/audit/store.ts).
 * A chain is the rows of one tenant, or (key "") the rows with none.
 */
import type { PrismaClient } from "@prisma/client"
import { checkpointHmac, GENESIS_HASH, linkHash, PLATFORM_CHAIN, type HashedRow } from "./chain-hash"
import { LOOKBACK_MS } from "./chainer"
import { checkpoints as loadCheckpoints, linkHashAt, unchainedOld, unchainedPending, verifyLinks } from "./store"

const PAGE = 5000
const PENDING_CAP = 1000

export type VerifyMode = "full" | "incremental"

export type ChainBreakKind =
  | "seq_gap" // a link is missing or inserted
  | "prev_hash_mismatch" // prevHash is not the previous link's rowHash
  | "row_hash_mismatch" // the AuditLog row no longer hashes to the link's rowHash
  | "row_missing" // a link names an AuditLog row that is gone
  | "unchained_row" // a row older than the chainer's lookback has no link
  | "checkpoint_invalid" // a checkpoint's HMAC does not verify
  | "checkpoint_mismatch" // the link a checkpoint names is gone or has another hash

export interface ChainBreak {
  /** The tenant id, "" for the platform chain. */
  chainKey: string
  kind: ChainBreakKind
  /** The row where the walk first failed; null where none applies. */
  auditLogId: string | null
  chainSeq: number | null
  detail: string
}

export interface ChainVerification {
  ok: boolean
  mode: VerifyMode
  chains: number
  rowsChecked: number
  /** Chains that passed, so a job may checkpoint them. */
  verifiedKeys: string[]
  /** One entry per broken chain: where its walk first failed. */
  breaks: ChainBreak[]
  /** Committed rows within the lookback that the chainer has not linked yet (capped); not a break. */
  pendingUnchained: number
}

type Db = Pick<PrismaClient, "$queryRaw">

async function chainKeys(db: Db, only?: string): Promise<string[]> {
  if (only !== undefined) return [only]
  const rows = await db.$queryRaw<Array<{ k: string }>>`SELECT "id" AS k FROM "Tenant" UNION SELECT '' ORDER BY k`
  return rows.map((r) => r.k)
}

function brk(key: string, kind: ChainBreakKind, detail: string, auditLogId: string | null = null, chainSeq: number | null = null): ChainBreak {
  return { chainKey: key, kind, auditLogId, chainSeq, detail }
}

async function unchained(db: Db, key: string, now: Date, floor: Date | null): Promise<{ old: string | null; pending: number }> {
  const cutoff = new Date(now.getTime() - LOOKBACK_MS)
  return { old: await unchainedOld(db, key, cutoff, floor), pending: await unchainedPending(db, key, cutoff, PENDING_CAP) }
}

async function verifyChain(db: Db, key: string, mode: VerifyMode, now: Date): Promise<{ broken: ChainBreak | null; rows: number; pending: number }> {
  const checkpoints = await loadCheckpoints(db, key)
  for (const cp of checkpoints) {
    if (cp.hmac !== checkpointHmac(key, cp.seq, cp.rowHash)) {
      return { broken: brk(key, "checkpoint_invalid", `checkpoint ${cp.id} (seq ${cp.seq}) does not verify`, null, cp.seq), rows: 0, pending: 0 }
    }
  }
  const byseq = new Map(checkpoints.map((cp) => [cp.seq, cp]))
  const start = mode === "incremental" ? checkpoints[checkpoints.length - 1] : undefined

  let seq = start?.seq ?? 0
  let hash = start?.rowHash ?? GENESIS_HASH
  let rows = 0
  if (start) {
    if ((await linkHashAt(db, key, start.seq)) !== start.rowHash) {
      return { broken: brk(key, "checkpoint_mismatch", `the link at seq ${start.seq} is gone or changed since its checkpoint`, null, start.seq), rows, pending: 0 }
    }
  }

  for (;;) {
    const page = await verifyLinks(db, key, seq, PAGE)
    if (page.length === 0) break
    for (const r of page) {
      rows++
      const at = (kind: ChainBreakKind, detail: string) => ({ broken: brk(key, kind, detail, r.linkAuditLogId, r.seq), rows, pending: 0 })
      if (r.seq !== seq + 1) return at("seq_gap", `expected seq ${seq + 1}, found ${r.seq}`)
      if (r.prevHash !== hash) return at("prev_hash_mismatch", "prevHash does not match the previous link's rowHash")
      if (!r.present) return at("row_missing", "the AuditLog row this link names is gone")
      if (r.rowHash !== linkHash(key, r.seq, r.prevHash, r as HashedRow)) return at("row_hash_mismatch", "the row's content no longer hashes to the link's rowHash")
      const cp = byseq.get(r.seq)
      if (cp && cp.rowHash !== r.rowHash) return at("checkpoint_mismatch", `the link no longer matches its checkpoint ${cp.id}`)
      seq = r.seq
      hash = r.rowHash
    }
  }

  const last = checkpoints[checkpoints.length - 1]
  if (last && last.seq > seq) {
    return { broken: brk(key, "checkpoint_mismatch", `the chain ends at seq ${seq}, before its checkpoint at seq ${last.seq}`, null, seq), rows, pending: 0 }
  }
  const floor = start ? new Date(start.createdAt.getTime() - 2 * LOOKBACK_MS) : null
  const { old, pending } = await unchained(db, key, now, floor)
  if (old) return { broken: brk(key, "unchained_row", "a row older than the chainer's lookback has no link", old), rows, pending }
  return { broken: null, rows, pending }
}

/**
 * Verifies every chain, or only `chainKey` (a tenant id; "" for the platform
 * chain) or `chainKeys` (for a test sharing a database). A tenant with no audit rows has no chain and passes.
 */
export async function verifyAuditChains(
  db: Db,
  opts: { chainKey?: string; chainKeys?: readonly string[]; mode?: VerifyMode; now?: Date } = {},
): Promise<ChainVerification> {
  const mode = opts.mode ?? "full"
  const now = opts.now ?? new Date()
  const keys = opts.chainKeys ? [...opts.chainKeys] : await chainKeys(db, opts.chainKey)
  const breaks: ChainBreak[] = []
  const verifiedKeys: string[] = []
  let rowsChecked = 0
  let pendingUnchained = 0
  for (const key of keys) {
    const { broken, rows, pending } = await verifyChain(db, key, mode, now)
    rowsChecked += rows
    pendingUnchained += pending
    if (broken) breaks.push(broken)
    else verifiedKeys.push(key)
  }
  return { ok: breaks.length === 0, mode, chains: keys.length, rowsChecked, verifiedKeys, breaks, pendingUnchained }
}

export { PLATFORM_CHAIN }
