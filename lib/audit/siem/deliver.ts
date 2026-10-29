/**
 * Ships the SIEM outbox. At-least-once: a row is marked sent only after the
 * SIEM acknowledges its batch, a batch whose answer was lost is sent again
 * (the receiver de-duplicates on eventId = the AuditLog id), and a crashed run's
 * claim expires after LEASE_SECONDS. A failure backs the batch off
 * exponentially (30 s doubling to 1 h); rows are never dropped for failing, so
 * an outage delays the feed and a later run catches up, oldest first.
 */
import { prisma } from "@/lib/prisma"
import { siemTarget } from "./policy"
import { toSiemEvent, type SiemSourceRow } from "./format"
import { sendToSiem, type SendResult, type SiemTarget, type TransportDeps } from "./transport"

const BATCH = 100
const MAX_BATCHES_PER_TENANT = 20
const LEASE_SECONDS = 120
const BACKOFF_BASE_SECONDS = 30
const BACKOFF_CAP_SECONDS = 3600
const SENT_KEPT_DAYS = 7

export type SiemSender = (target: SiemTarget, events: ReturnType<typeof toSiemEvent>[], deps?: TransportDeps) => Promise<SendResult>

export interface DeliveryResult {
  tenants: number
  sent: number
  failedBatches: number
  failedTenants: number
  /** Age in seconds of the oldest unsent row due now, null when none. */
  oldestPendingSeconds: number | null
}

export function backoffSeconds(attempts: number): number {
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_SECONDS)
}

interface Claimed { auditLogId: string; attempts: number }

async function claim(tenantId: string, now: Date): Promise<Claimed[]> {
  const lease = new Date(now.getTime() + LEASE_SECONDS * 1000)
  return prisma.$queryRaw<Claimed[]>`
    UPDATE "AuditSiemOutbox" SET "nextAttemptAt" = ${lease}, "attempts" = "attempts" + 1
    WHERE "auditLogId" IN (
      SELECT "auditLogId" FROM "AuditSiemOutbox"
      WHERE "tenantId" = ${tenantId} AND "sentAt" IS NULL AND "nextAttemptAt" <= ${now}
      ORDER BY "chainSeq" LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
    RETURNING "auditLogId", "attempts"`
}

async function deliverTenant(tenantId: string, target: SiemTarget, now: Date, send: SiemSender, deps: TransportDeps) {
  let sent = 0
  for (let n = 0; n < MAX_BATCHES_PER_TENANT; n++) {
    const claimed = await claim(tenantId, now)
    if (claimed.length === 0) return { sent, failed: false }
    const ids = claimed.map((c) => c.auditLogId)
    const rows = await prisma.auditLog.findMany({ where: { id: { in: ids } }, orderBy: { chainSeq: "asc" } })
    // An outbox row whose audit row is gone has nothing to ship.
    const present = new Set(rows.map((r) => r.id))
    const orphans = ids.filter((id) => !present.has(id))
    if (orphans.length > 0) await prisma.auditSiemOutbox.deleteMany({ where: { auditLogId: { in: orphans } } })
    if (rows.length === 0) continue

    const result = await send(target, rows.map((r) => toSiemEvent(r as SiemSourceRow)), deps)
    if (result.ok) {
      await prisma.auditSiemOutbox.updateMany({ where: { auditLogId: { in: rows.map((r) => r.id) } }, data: { sentAt: now, lastError: null } })
      sent += rows.length
      continue
    }
    const attempts = Math.max(...claimed.map((c) => c.attempts))
    const retryAt = new Date(now.getTime() + backoffSeconds(attempts) * 1000)
    await prisma.auditSiemOutbox.updateMany({
      where: { auditLogId: { in: rows.map((r) => r.id) } },
      data: { nextAttemptAt: retryAt, lastError: result.error },
    })
    console.error("[audit-siem] delivery failed", { tenantId, rows: rows.length, attempts, error: result.error })
    return { sent, failed: true }
  }
  return { sent, failed: false }
}

export async function deliverSiemOutbox(opts: { now?: Date; send?: SiemSender; deps?: TransportDeps } = {}): Promise<DeliveryResult> {
  const now = opts.now ?? new Date()
  const send = opts.send ?? sendToSiem
  const due = await prisma.auditSiemOutbox.groupBy({ by: ["tenantId"], where: { sentAt: null, nextAttemptAt: { lte: now } } })
  const result: DeliveryResult = { tenants: due.length, sent: 0, failedBatches: 0, failedTenants: 0, oldestPendingSeconds: null }

  for (const { tenantId } of due) {
    try {
      const policy = await prisma.auditPolicy.findUnique({ where: { tenantId } })
      if (!policy?.siemEnabled) continue
      const out = await deliverTenant(tenantId, siemTarget(policy), now, send, opts.deps ?? {})
      result.sent += out.sent
      if (out.failed) result.failedBatches++
    } catch (error) {
      // A sealed secret that no longer opens, a database fault: this lender's feed waits, the others go on.
      result.failedTenants++
      console.error("[audit-siem] tenant failed", { tenantId, error })
    }
  }

  const oldest = await prisma.auditSiemOutbox.findFirst({ where: { sentAt: null }, orderBy: { createdAt: "asc" }, select: { createdAt: true } })
  result.oldestPendingSeconds = oldest ? Math.max(0, Math.round((now.getTime() - oldest.createdAt.getTime()) / 1000)) : null
  await prisma.auditSiemOutbox.deleteMany({ where: { sentAt: { lt: new Date(now.getTime() - SENT_KEPT_DAYS * 86_400_000) } } })
  return result
}

/** Sends one synthetic event, to prove a target works before it is switched on. */
export async function sendTestEvent(target: SiemTarget, tenantId: string, send: SiemSender = sendToSiem, deps: TransportDeps = {}): Promise<SendResult> {
  const row: SiemSourceRow = {
    id: `test-${Date.now()}`, tenantId, userId: null, userEmail: null, action: "AUDIT_SIEM_TEST", entity: "AuditPolicy", entityId: null,
    oldValue: null, newValue: { test: true }, ipAddress: null, createdAt: new Date(), chainSeq: null, rowHash: null, prevHash: null,
  }
  return send(target, [toSiemEvent(row)], deps)
}
