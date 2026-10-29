/**
 * Walks the AuditLog hash chains and reports every break in each.
 *
 * `full` walks every link from the genesis; `incremental` starts at the chain's latest VALID
 * checkpoint (after proving the link it names still has that hash), which is what the daily job
 * runs on weekdays. Reads only. A chain is the rows of one tenant, or (key "") the rows with none.
 *
 * It does not stop at the first break: it reports each, resynchronises on the link where it
 * stands, and goes on, so one damaged link does not hide a second. A checkpoint whose signature
 * fails is reported and skipped (the walk uses the one before it), and a break an operator signed
 * off (audit_chain_accept_break, verified here under AUDIT_CHAIN_KEY) is listed as `accepted`
 * and does not fail the chain. Only a chain with no unaccepted break is `verified`, and the
 * (seq, rowHash) of the last link the walk checked is what a checkpoint may sign.
 *
 * Needs AUDIT_CHAIN_KEY, so it runs on the worker (the web login has no key and no access).
 */
import type { PrismaClient } from "@prisma/client"
import { checkpointHmac, GENESIS_HASH, linkHash, PLATFORM_CHAIN, repairHmac, type RowInputs } from "./chain-hash"
import { UNCHAINED_GRACE_MS } from "./chainer"
import { chainRepairs, checkpoints as loadCheckpoints, linkHashAt, unchainedOld, unchainedPending, verifyLinks, type CheckpointRow } from "./store"

const PAGE = 5000
const PENDING_CAP = 1000
const MAX_BREAKS_PER_CHAIN = 50

export type VerifyMode = "full" | "incremental"

export type ChainBreakKind =
  | "seq_gap" // a link is missing or inserted
  | "prev_hash_mismatch" // prevHash is not the previous link's rowHash
  | "row_hash_mismatch" // the AuditLog row no longer hashes to the link's rowHash
  | "row_missing" // a link names an AuditLog row that is gone
  | "unchained_row" // a row older than the grace has no link
  | "checkpoint_invalid" // a checkpoint's HMAC does not verify
  | "checkpoint_mismatch" // the link a checkpoint names is gone or has another hash
  | "repair_invalid" // an accepted-break record whose signature does not verify

export interface ChainBreak {
  /** The tenant id, "" for the platform chain. */
  chainKey: string
  kind: ChainBreakKind
  /** The row where the walk failed; null where none applies. */
  auditLogId: string | null
  chainSeq: number | null
  detail: string
}

export interface ChainVerification {
  /** No unaccepted break anywhere. */
  ok: boolean
  mode: VerifyMode
  chains: number
  rowsChecked: number
  /** Chains that passed, so a job may checkpoint them. */
  verifiedKeys: string[]
  /**
   * For each chain that passed, the last link the walk actually checked (seq and rowHash). A
   * checkpoint signs exactly this pair, never the head as it is when the job gets to it: a
   * link appended or swapped after the walk has not been verified.
   */
  verifiedHeads: Array<{ chainKey: string; seq: number; rowHash: string }>
  /** Every unaccepted break, per chain at most 50. */
  breaks: ChainBreak[]
  /** Breaks an operator signed off (they do not fail the chain). */
  accepted: ChainBreak[]
  /** Committed rows the chainer has not linked yet and that are not old enough to be a break (capped). */
  pendingUnchained: number
}

type Db = Pick<PrismaClient, "$queryRaw">

interface ChainWalk { breaks: ChainBreak[]; accepted: ChainBreak[]; rows: number; pending: number; seq?: number; hash?: string }

async function chainKeys(db: Db, only?: string): Promise<string[]> {
  if (only !== undefined) return [only]
  const rows = await db.$queryRaw<Array<{ k: string }>>`SELECT "id" AS k FROM "Tenant" UNION SELECT '' ORDER BY k`
  return rows.map((r) => r.k)
}

function brk(key: string, kind: ChainBreakKind, detail: string, auditLogId: string | null = null, chainSeq: number | null = null): ChainBreak {
  return { chainKey: key, kind, auditLogId, chainSeq, detail }
}

async function verifyChain(db: Db, key: string, mode: VerifyMode, now: Date): Promise<ChainWalk> {
  const breaks: ChainBreak[] = []
  const accepted: ChainBreak[] = []

  // Operator-accepted breaks, kept only where the signature verifies.
  const signed = new Set<string>()
  for (const rp of await chainRepairs(db, key)) {
    if (rp.hmac === repairHmac(key, rp.seq, rp.kind, rp.reason, rp.operator)) signed.add(`${rp.seq}|${rp.kind}`)
    else breaks.push(brk(key, "repair_invalid", `the accepted-break record ${rp.id} (seq ${rp.seq}) does not verify`, null, rp.seq))
  }
  const report = (b: ChainBreak): boolean => {
    if (b.chainSeq !== null && signed.has(`${b.chainSeq}|${b.kind}`)) { accepted.push(b); return true }
    if (breaks.length < MAX_BREAKS_PER_CHAIN) breaks.push(b)
    return false
  }

  // Checkpoints: a forged or damaged one is reported and not relied on.
  const all = await loadCheckpoints(db, key)
  const valid: CheckpointRow[] = []
  for (const cp of all) {
    if (cp.hmac === checkpointHmac(key, cp.seq, cp.rowHash)) valid.push(cp)
    else report(brk(key, "checkpoint_invalid", `checkpoint ${cp.id} (seq ${cp.seq}) does not verify`, null, cp.seq))
  }
  const byseq = new Map(valid.map((cp) => [cp.seq, cp]))
  let start = mode === "incremental" ? valid[valid.length - 1] : undefined
  if (start && (await linkHashAt(db, key, start.seq)) !== start.rowHash) {
    report(brk(key, "checkpoint_mismatch", `the link at seq ${start.seq} is gone or changed since its checkpoint`, null, start.seq))
    start = undefined // do not trust it as a starting point: walk the whole chain
  }

  let seq = start?.seq ?? 0
  let hash = start?.rowHash ?? GENESIS_HASH
  let rows = 0
  for (;;) {
    const page = await verifyLinks(db, key, seq, PAGE)
    if (page.length === 0) break
    for (const r of page) {
      rows++
      const at = (kind: ChainBreakKind, detail: string) => report(brk(key, kind, detail, r.linkAuditLogId, r.seq))
      if (r.seq !== seq + 1) at("seq_gap", `expected seq ${seq + 1}, found ${r.seq}`)
      else if (r.prevHash !== hash) at("prev_hash_mismatch", "prevHash does not match the previous link's rowHash")
      else if (!r.present) at("row_missing", "the AuditLog row this link names is gone")
      else if (r.rowHash !== linkHash(key, r.seq, r.prevHash, r as RowInputs)) at("row_hash_mismatch", "the row's content no longer hashes to the link's rowHash")
      else {
        const cp = byseq.get(r.seq)
        if (cp && cp.rowHash !== r.rowHash) at("checkpoint_mismatch", `the link no longer matches its checkpoint ${cp.id}`)
      }
      // Resynchronise on this link whatever was found, so the walk reports what follows.
      seq = r.seq
      hash = r.rowHash
    }
  }

  const last = valid[valid.length - 1]
  if (last && last.seq > seq) report(brk(key, "checkpoint_mismatch", `the chain ends at seq ${seq}, before its checkpoint at seq ${last.seq}`, null, seq))

  // No lower bound: a row with no link is a break wherever it is. (Younger than the grace it is pending.)
  const cutoff = new Date(now.getTime() - UNCHAINED_GRACE_MS)
  const old = await unchainedOld(db, key, cutoff)
  if (old) report(brk(key, "unchained_row", "a row older than the grace period has no link", old))
  const pending = await unchainedPending(db, key, cutoff, PENDING_CAP)
  return { breaks, accepted, rows, pending, seq, hash }
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
  const accepted: ChainBreak[] = []
  const verifiedKeys: string[] = []
  const verifiedHeads: ChainVerification["verifiedHeads"] = []
  let rowsChecked = 0
  let pendingUnchained = 0
  for (const key of keys) {
    const walk = await verifyChain(db, key, mode, now)
    rowsChecked += walk.rows
    pendingUnchained += walk.pending
    breaks.push(...walk.breaks)
    accepted.push(...walk.accepted)
    if (walk.breaks.length === 0) {
      verifiedKeys.push(key)
      if (walk.seq !== undefined && walk.seq > 0 && walk.hash) verifiedHeads.push({ chainKey: key, seq: walk.seq, rowHash: walk.hash })
    }
  }
  return { ok: breaks.length === 0, mode, chains: keys.length, rowsChecked, verifiedKeys, verifiedHeads, breaks, accepted, pendingUnchained }
}

export { PLATFORM_CHAIN }
