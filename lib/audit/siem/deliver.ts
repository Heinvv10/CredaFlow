/**
 * Ships the SIEM outbox. At-least-once, and in order per lender: one delivery
 * transaction per lender holds pg_try_advisory_xact_lock (a second replica skips
 * that lender), sends the oldest pending rows in batches, and stops at the first
 * batch that fails, so a lender's SIEM never sees seq 9 before seq 8. A batch is
 * marked sent only after the SIEM acknowledges it; one whose answer was lost is
 * sent again (the receiver de-duplicates on eventId). A failure backs the batch
 * off exponentially (30 s doubling to 1 h) and never drops it, except a row the
 * SIEM rejects with a 4xx that retrying cannot fix: the batch is split until the
 * bad row stands alone, and that row is marked dead after PERMANENT_ATTEMPTS.
 *
 * Only chained rows ship (their seq and hash go with them). Rows queued for a
 * lender that has switched forwarding off are pruned; the history is in AuditLog
 * and the anchor event sent when forwarding starts again names where it resumes.
 */
import type { Prisma, PrismaClient } from "@prisma/client"
import { deliveryClient } from "./delivery-db"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { GENESIS_HASH } from "@/lib/audit/chain-hash"
import {
  checkpointById, dueTenants, linkHashAt, markOutbox, oldestPending, outboxSources, pruneUnsent, purgeSent, snapshotRows, streamRows,
  type OutboxRow as StoredRow,
} from "@/lib/audit/store"
import { siemTarget, type TargetSnapshot } from "./policy"
import { toSiemEvent, type SiemEvent, type SiemSourceRow } from "./format"
import { sendToSiem, type SendResult, type SiemTarget, type TransportDeps } from "./transport"

const BATCH = 100
const MAX_BATCHES_PER_TENANT = 20
const MAX_BATCH_BYTES = 256 * 1024
const BACKOFF_BASE_SECONDS = 30
const BACKOFF_CAP_SECONDS = 3600
const PERMANENT_ATTEMPTS = 3

export type SiemSender = (target: SiemTarget, events: SiemEvent[], deps?: TransportDeps) => Promise<SendResult>

export interface DeliveryResult {
  tenants: number
  sent: number
  dead: number
  failedBatches: number
  failedTenants: number
  /** Age in seconds of the oldest unsent row, null when none. */
  oldestPendingSeconds: number | null
}

export function backoffSeconds(attempts: number): number {
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_SECONDS)
}

type OutboxRow = StoredRow<TargetSnapshot>
type Tx = Prisma.TransactionClient
interface Ctx { tx: Tx; tenantId: string; now: Date; send: SiemSender; deps: TransportDeps; result: DeliveryResult }
interface Item { row: OutboxRow; event: SiemEvent }

/** The destination a receipt names: a host or origin, never a credential or a path (which may carry a key). */
function destinationOf(t: SiemTarget): string {
  if (t.transport === "SYSLOG_TLS") return `syslog+tls://${t.host ?? "?"}:${t.port ?? "?"}`
  try { return new URL(t.url ?? "").origin } catch { return "https://?" }
}

async function markDead(ctx: Ctx, row: OutboxRow, error: string) {
  await markOutbox(ctx.tx, ctx.tenantId, [row.id], "dead", error, ctx.now, "-")
  ctx.result.dead++
}

async function eventsFor(ctx: Ctx, rows: OutboxRow[]): Promise<Item[]> {
  const out: Item[] = []
  const audits = new Map<string, SiemSourceRow>()
  const ids = rows.flatMap((r) => (r.auditLogId ? [r.auditLogId] : []))
  if (ids.length > 0) {
    for (const r of await outboxSources(ctx.tx, ids)) {
      audits.set(r.id, { ...r, chainSeq: r.linkSeq, rowHash: r.linkRowHash, prevHash: r.linkPrevHash })
    }
  }
  for (const row of rows) {
    if (row.kind === "EVENT") {
      const source = audits.get(row.auditLogId ?? "")
      if (!source) {
        // The audit row or its link is gone: nothing true to send. The verifier reports the loss.
        await markDead(ctx, row, "row_missing")
        continue
      }
      out.push({ row, event: toSiemEvent(source) })
    } else if (row.kind === "ANCHOR") {
      // The chain position when forwarding was set up (the row's seq), and the hash the link there has now.
      const seq = row.seq ?? 0
      const rowHash = seq > 0 ? await linkHashAt(ctx.tx, ctx.tenantId, seq) : GENESIS_HASH
      out.push({ row, event: toSiemEvent({
        id: `anchor-${row.id}`, tenantId: ctx.tenantId, userId: null, action: "AUDIT_FORWARDING_STARTED", entity: "AuditLog", entityId: null,
        oldValue: null, newValue: null, ipAddress: null, createdAt: row.createdAt, chainSeq: seq, rowHash: rowHash ?? GENESIS_HASH, prevHash: null,
      }) })
    } else {
      const cp = row.checkpointId ? await checkpointById(ctx.tx, row.checkpointId) : null
      if (!cp) {
        await markDead(ctx, row, "row_missing")
        continue
      }
      out.push({ row, event: toSiemEvent({
        id: `checkpoint-${cp.id}`, tenantId: ctx.tenantId, userId: null, action: "AUDIT_CHAIN_CHECKPOINT", entity: "AuditLog", entityId: null,
        oldValue: null, newValue: { seq: cp.seq, rowHash: cp.rowHash, hmac: cp.hmac }, ipAddress: null, createdAt: cp.createdAt,
        chainSeq: cp.seq, rowHash: cp.rowHash, prevHash: null,
      }) })
    }
  }
  return out
}

/** Sends `items`, splitting on a poison answer. Returns false when the stream must stop (a transient failure). */
async function sendItems(ctx: Ctx, target: SiemTarget, items: Item[]): Promise<boolean> {
  if (items.length === 0) return true
  const r = await ctx.send(target, items.map((i) => i.event), ctx.deps)
  const rows = items.map((i) => i.row)
  const ids = rows.map((x) => x.id)
  if (r.ok) {
    await markOutbox(ctx.tx, ctx.tenantId, ids, "sent", null, ctx.now, destinationOf(target))
    ctx.result.sent += rows.length
    return true
  }
  if (r.permanent && items.length > 1) {
    const mid = Math.ceil(items.length / 2)
    return (await sendItems(ctx, target, items.slice(0, mid))) && (await sendItems(ctx, target, items.slice(mid)))
  }
  const attempts = Math.max(...rows.map((x) => x.attempts)) + 1
  const dead = r.permanent === true && attempts >= PERMANENT_ATTEMPTS
  const error = r.error ?? "send_failed"
  if (dead) {
    await markOutbox(ctx.tx, ctx.tenantId, ids, "dead", error, ctx.now, destinationOf(target))
    ctx.result.dead += rows.length
  } else {
    await markOutbox(ctx.tx, ctx.tenantId, ids, "retry", error, new Date(ctx.now.getTime() + backoffSeconds(attempts) * 1000), destinationOf(target))
  }
  ctx.result.failedBatches++
  console.error("[audit-siem] delivery failed", { tenantId: ctx.tenantId, rows: rows.length, error: r.error, dead })
  // A row dead for poison no longer blocks the stream; anything else does.
  return dead
}

/** The prefix of `items` whose serialised events fit one request. */
function withinSize(items: Item[]): Item[] {
  let bytes = 0
  const kept: Item[] = []
  for (const item of items) {
    bytes += Buffer.byteLength(JSON.stringify(item.event))
    if (kept.length > 0 && bytes > MAX_BATCH_BYTES) break
    kept.push(item)
  }
  return kept
}

/** In order: while the oldest row is backing off, nothing behind it goes. */
function duePrefix(rows: OutboxRow[], now: Date): OutboxRow[] {
  const end = rows.findIndex((r) => r.nextAttemptAt > now)
  return end === -1 ? rows : rows.slice(0, end)
}

/**
 * Rows stamped with the destination a lender moved away from (the policy-change
 * event and whatever was queued behind it): one ordered stream per old destination,
 * outside the order of the current one. A failed stream stops at its first failure;
 * the others go on.
 */
async function drainSnapshots(ctx: Ctx): Promise<void> {
  for (let n = 0; n < MAX_BATCHES_PER_TENANT; n++) {
    const groups = new Map<string, OutboxRow[]>()
    for (const row of await snapshotRows<TargetSnapshot>(ctx.tx, ctx.tenantId, BATCH)) {
      const key = JSON.stringify(row.targetSnapshot)
      groups.set(key, [...(groups.get(key) ?? []), row])
    }
    let progressed = false
    for (const group of groups.values()) {
      const due = duePrefix(group, ctx.now)
      if (due.length === 0) continue
      let target: SiemTarget
      try {
        target = siemTarget(group[0].targetSnapshot as TargetSnapshot)
      } catch (error) {
        console.error("[audit-siem] snapshot target unusable", { tenantId: ctx.tenantId, error })
        await markOutbox(ctx.tx, ctx.tenantId, due.map((r) => r.id), "retry", "config_invalid", new Date(ctx.now.getTime() + backoffSeconds(1) * 1000), "-")
        continue
      }
      const items = withinSize(await eventsFor(ctx, due))
      if (items.length === 0 || (await sendItems(ctx, target, items))) progressed = true
    }
    if (!progressed) return
  }
}

async function deliverTenant(ctx: Ctx): Promise<void> {
  const { tx, tenantId, now } = ctx
  const [lock] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`audit-siem:${tenantId}`}, 0)) AS ok`
  if (!lock.ok) return
  const [policy] = await tx.$queryRaw<Array<{ siemEnabled: boolean } & TargetSnapshot>>`SELECT * FROM "AuditPolicy" WHERE "tenantId" = ${tenantId}`

  await drainSnapshots(ctx)

  if (!policy?.siemEnabled) {
    await pruneUnsent(tx, tenantId)
    return
  }
  const target = siemTarget(policy)
  for (let n = 0; n < MAX_BATCHES_PER_TENANT; n++) {
    const due = duePrefix((await streamRows(tx, tenantId, BATCH)) as OutboxRow[], now)
    if (due.length === 0) return
    const items = withinSize(await eventsFor(ctx, due))
    if (items.length === 0) continue
    if (!(await sendItems(ctx, target, items))) return
  }
}

export async function deliverSiemOutbox(opts: { db?: PrismaClient; now?: Date; send?: SiemSender; deps?: TransportDeps } = {}): Promise<DeliveryResult> {
  const db = (opts.db ?? deliveryClient()) as unknown as PrismaClient
  const now = opts.now ?? new Date()
  const send = opts.send ?? sendToSiem
  const result: DeliveryResult = { tenants: 0, sent: 0, dead: 0, failedBatches: 0, failedTenants: 0, oldestPendingSeconds: null }

  return withoutTenantScope(async () => {
    const due = await dueTenants(db, now)
    result.tenants = due.length
    for (const tenantId of due) {
      try {
        await db.$transaction((tx: Tx) => deliverTenant({ tx, tenantId, now, send, deps: opts.deps ?? {}, result }), { timeout: 5 * 60_000, maxWait: 10_000 })
      } catch (error) {
        // A sealed secret that no longer opens, a database fault: this lender's feed waits, the others go on.
        result.failedTenants++
        console.error("[audit-siem] tenant failed", { tenantId, error })
      }
    }
    const oldest = await oldestPending(db)
    result.oldestPendingSeconds = oldest ? Math.max(0, Math.round((now.getTime() - oldest.getTime()) / 1000)) : null
    await purgeSent(db)
    return result
  })
}

/** Sends one synthetic event, to prove a target works before it is switched on. Returns a coarse class only. */
export async function sendTestEvent(target: SiemTarget, tenantId: string, send: SiemSender = sendToSiem, deps: TransportDeps = {}): Promise<SendResult> {
  const event = toSiemEvent({
    id: `test-${Date.now()}`, tenantId, userId: null, action: "AUDIT_SIEM_TEST", entity: "AuditPolicy", entityId: null,
    oldValue: null, newValue: { test: true }, ipAddress: null, createdAt: new Date(), chainSeq: null, rowHash: null, prevHash: null,
  })
  return send(target, [event], deps)
}
