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
import { Prisma, type PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { GENESIS_HASH } from "@/lib/audit/chain-hash"
import { siemTarget, type TargetSnapshot } from "./policy"
import { toSiemEvent, type SiemEvent, type SiemSourceRow } from "./format"
import { sendToSiem, type SendResult, type SiemTarget, type TransportDeps } from "./transport"

const BATCH = 100
const MAX_BATCHES_PER_TENANT = 20
const MAX_BATCH_BYTES = 256 * 1024
const BACKOFF_BASE_SECONDS = 30
const BACKOFF_CAP_SECONDS = 3600
const PERMANENT_ATTEMPTS = 3
const SENT_KEPT_DAYS = 7

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

interface OutboxRow {
  id: number
  kind: string
  auditLogId: string | null
  checkpointId: string | null
  seq: number | null
  targetSnapshot: TargetSnapshot | null
  attempts: number
  nextAttemptAt: Date
  createdAt: Date
}

type Tx = Prisma.TransactionClient
interface Ctx { tx: Tx; tenantId: string; now: Date; send: SiemSender; deps: TransportDeps; result: DeliveryResult }

async function eventsFor(ctx: Ctx, rows: OutboxRow[]): Promise<Array<{ row: OutboxRow; event: SiemEvent }>> {
  const out: Array<{ row: OutboxRow; event: SiemEvent }> = []
  const audits = new Map<string, SiemSourceRow>()
  const ids = rows.flatMap((r) => (r.auditLogId ? [r.auditLogId] : []))
  if (ids.length > 0) {
    const found = await ctx.tx.$queryRaw<Array<SiemSourceRow & { linkSeq: number; linkRowHash: string; linkPrevHash: string }>>`
      SELECT a."id", a."tenantId", a."userId", a."action", a."entity", a."entityId", a."oldValue", a."newValue", a."ipAddress", a."createdAt",
             l."seq" AS "linkSeq", l."rowHash" AS "linkRowHash", l."prevHash" AS "linkPrevHash"
      FROM "AuditLog" a JOIN "AuditChainLink" l ON l."auditLogId" = a."id" WHERE a."id" = ANY(${ids})`
    for (const r of found) audits.set(r.id, { ...r, chainSeq: r.linkSeq, rowHash: r.linkRowHash, prevHash: r.linkPrevHash })
  }
  for (const row of rows) {
    if (row.kind === "EVENT") {
      const source = audits.get(row.auditLogId ?? "")
      if (!source) {
        // The audit row or its link is gone: nothing true to send. The verifier reports the loss.
        await ctx.tx.$executeRaw`UPDATE "AuditSiemOutbox" SET "deadAt" = ${ctx.now}, "lastError" = 'row_missing' WHERE "id" = ${row.id}`
        ctx.result.dead++
        continue
      }
      out.push({ row, event: toSiemEvent(source) })
    } else if (row.kind === "ANCHOR") {
      const [head] = await ctx.tx.$queryRaw<Array<{ seq: number; rowHash: string }>>`
        SELECT "seq", "rowHash" FROM "AuditChainLink" WHERE "chainKey" = ${ctx.tenantId} ORDER BY "seq" DESC LIMIT 1`
      out.push({ row, event: toSiemEvent({
        id: `anchor-${row.id}`, tenantId: ctx.tenantId, userId: null, action: "AUDIT_FORWARDING_STARTED", entity: "AuditLog", entityId: null,
        oldValue: null, newValue: null, ipAddress: null, createdAt: row.createdAt, chainSeq: head?.seq ?? 0, rowHash: head?.rowHash ?? GENESIS_HASH, prevHash: null,
      }) })
    } else {
      const [cp] = await ctx.tx.$queryRaw<Array<{ id: string; seq: number; rowHash: string; hmac: string; createdAt: Date }>>`
        SELECT "id", "seq", "rowHash", "hmac", "createdAt" FROM "AuditChainCheckpoint" WHERE "id" = ${row.checkpointId}`
      if (!cp) {
        await ctx.tx.$executeRaw`UPDATE "AuditSiemOutbox" SET "deadAt" = ${ctx.now}, "lastError" = 'row_missing' WHERE "id" = ${row.id}`
        ctx.result.dead++
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

async function markSent(ctx: Ctx, rows: OutboxRow[]) {
  await ctx.tx.$executeRaw`UPDATE "AuditSiemOutbox" SET "sentAt" = ${ctx.now}, "lastError" = NULL WHERE "id" = ANY(${rows.map((r) => r.id)})`
  ctx.result.sent += rows.length
}

async function markFailed(ctx: Ctx, rows: OutboxRow[], error: string, dead: boolean) {
  const attempts = Math.max(...rows.map((r) => r.attempts)) + 1
  const retryAt = new Date(ctx.now.getTime() + backoffSeconds(attempts) * 1000)
  const ids = rows.map((r) => r.id)
  if (dead) {
    await ctx.tx.$executeRaw`UPDATE "AuditSiemOutbox" SET "attempts" = "attempts" + 1, "deadAt" = ${ctx.now}, "lastError" = ${error} WHERE "id" = ANY(${ids})`
    ctx.result.dead += rows.length
  } else {
    await ctx.tx.$executeRaw`UPDATE "AuditSiemOutbox" SET "attempts" = "attempts" + 1, "nextAttemptAt" = ${retryAt}, "lastError" = ${error} WHERE "id" = ANY(${ids})`
  }
}

/** Sends `items`, splitting on a poison answer. Returns false when the stream must stop (a transient failure). */
async function sendItems(ctx: Ctx, target: SiemTarget, items: Array<{ row: OutboxRow; event: SiemEvent }>): Promise<boolean> {
  if (items.length === 0) return true
  const r = await ctx.send(target, items.map((i) => i.event), ctx.deps)
  const rows = items.map((i) => i.row)
  if (r.ok) { await markSent(ctx, rows); return true }
  if (r.permanent && items.length > 1) {
    const mid = Math.ceil(items.length / 2)
    return (await sendItems(ctx, target, items.slice(0, mid))) && (await sendItems(ctx, target, items.slice(mid)))
  }
  const dead = r.permanent === true && Math.max(...rows.map((x) => x.attempts)) + 1 >= PERMANENT_ATTEMPTS
  await markFailed(ctx, rows, r.error ?? "send_failed", dead)
  ctx.result.failedBatches++
  console.error("[audit-siem] delivery failed", { tenantId: ctx.tenantId, rows: rows.length, error: r.error, dead })
  // A row dead for poison no longer blocks the stream; anything else does.
  return dead
}

/** The prefix of `items` whose serialised events fit one request. */
function withinSize(items: Array<{ row: OutboxRow; event: SiemEvent }>) {
  let bytes = 0
  const kept: typeof items = []
  for (const item of items) {
    bytes += Buffer.byteLength(JSON.stringify(item.event))
    if (kept.length > 0 && bytes > MAX_BATCH_BYTES) break
    kept.push(item)
  }
  return kept
}

const SELECT_PENDING = Prisma.sql`
  SELECT o."id", o."kind", o."auditLogId", o."checkpointId", o."seq", o."targetSnapshot", o."attempts", o."nextAttemptAt", o."createdAt"
  FROM "AuditSiemOutbox" o`

async function deliverTenant(ctx: Ctx): Promise<void> {
  const { tx, tenantId, now } = ctx
  const [lock] = await tx.$queryRaw<Array<{ ok: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`audit-siem:${tenantId}`}, 0)) AS ok`
  if (!lock.ok) return
  const [policy] = await tx.$queryRaw<Array<{ siemEnabled: boolean } & TargetSnapshot>>`SELECT * FROM "AuditPolicy" WHERE "tenantId" = ${tenantId}`

  // Policy-change rows bound for the destination a lender moved away from: each on its own, outside the main stream's order.
  const snapshots = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`${SELECT_PENDING}
    JOIN "AuditChainLink" l ON l."auditLogId" = o."auditLogId"
    WHERE o."tenantId" = ${tenantId} AND o."sentAt" IS NULL AND o."deadAt" IS NULL AND o."targetSnapshot" IS NOT NULL AND o."nextAttemptAt" <= ${now}
    ORDER BY o."id" LIMIT ${BATCH}`)
  for (const row of snapshots) {
    try {
      await sendItems(ctx, siemTarget(row.targetSnapshot as TargetSnapshot), await eventsFor(ctx, [row]))
    } catch (error) {
      console.error("[audit-siem] snapshot target unusable", { tenantId, outboxId: row.id, error })
      await markFailed(ctx, [row], "config_invalid", false)
    }
  }

  if (!policy?.siemEnabled) {
    await tx.$executeRaw`DELETE FROM "AuditSiemOutbox" WHERE "tenantId" = ${tenantId} AND "sentAt" IS NULL AND "deadAt" IS NULL AND "targetSnapshot" IS NULL`
    return
  }
  const target = siemTarget(policy)
  for (let n = 0; n < MAX_BATCHES_PER_TENANT; n++) {
    const pending = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`${SELECT_PENDING}
      LEFT JOIN "AuditChainLink" l ON l."auditLogId" = o."auditLogId"
      WHERE o."tenantId" = ${tenantId} AND o."sentAt" IS NULL AND o."deadAt" IS NULL AND o."targetSnapshot" IS NULL
        AND (o."auditLogId" IS NULL OR l."auditLogId" IS NOT NULL)
      ORDER BY o."id" LIMIT ${BATCH}`)
    // In order: while the oldest row is backing off, nothing behind it goes.
    const due = pending.filter((_, i) => pending.slice(0, i + 1).every((r) => r.nextAttemptAt <= now))
    if (due.length === 0) return
    const items = withinSize(await eventsFor(ctx, due))
    if (items.length === 0) continue
    if (!(await sendItems(ctx, target, items))) return
  }
}

export async function deliverSiemOutbox(opts: { db?: PrismaClient; now?: Date; send?: SiemSender; deps?: TransportDeps } = {}): Promise<DeliveryResult> {
  const db = (opts.db ?? prisma) as unknown as PrismaClient
  const now = opts.now ?? new Date()
  const send = opts.send ?? sendToSiem
  const result: DeliveryResult = { tenants: 0, sent: 0, dead: 0, failedBatches: 0, failedTenants: 0, oldestPendingSeconds: null }

  return withoutTenantScope(async () => {
    const due = await db.$queryRaw<Array<{ tenantId: string }>>`
      SELECT DISTINCT "tenantId" FROM "AuditSiemOutbox" WHERE "sentAt" IS NULL AND "deadAt" IS NULL AND "nextAttemptAt" <= ${now}`
    result.tenants = due.length
    for (const { tenantId } of due) {
      try {
        await db.$transaction((tx: Tx) => deliverTenant({ tx, tenantId, now, send, deps: opts.deps ?? {}, result }), { timeout: 5 * 60_000, maxWait: 10_000 })
      } catch (error) {
        // A sealed secret that no longer opens, a database fault: this lender's feed waits, the others go on.
        result.failedTenants++
        console.error("[audit-siem] tenant failed", { tenantId, error })
      }
    }
    const [oldest] = await db.$queryRaw<Array<{ createdAt: Date }>>`
      SELECT "createdAt" FROM "AuditSiemOutbox" WHERE "sentAt" IS NULL AND "deadAt" IS NULL ORDER BY "id" LIMIT 1`
    result.oldestPendingSeconds = oldest ? Math.max(0, Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000)) : null
    await db.$executeRaw`DELETE FROM "AuditSiemOutbox" WHERE "sentAt" < ${new Date(now.getTime() - SENT_KEPT_DAYS * 86_400_000)}`
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
