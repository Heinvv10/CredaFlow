import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { openSecret } from "@/lib/crypto/secret-box"
import { nextAttemptAfter } from "@/lib/lender-api/webhooks/events"
import { SIGNATURE_HEADER, signWebhookBody } from "@/lib/lender-api/webhooks/signing"
import { postWebhook, type PostDeps } from "@/lib/lender-api/webhooks/post"
import { webhookSecretKey } from "@/lib/lender-api/webhooks/endpoints"

/**
 * The webhook cron (app/api/cron/webhook-deliveries), in two steps:
 *
 * fanOutEvents — each undispatched WebhookEvent (written by the outbox
 * triggers) becomes one PENDING WebhookDelivery per active endpoint of its
 * tenant subscribed to its type, and is marked dispatched, in one transaction.
 * Rows are claimed FOR UPDATE SKIP LOCKED, so two runs never fan out one event.
 *
 * deliverDue — claims due PENDING deliveries in small batches by pushing their
 * nextAttemptAt forward by LEASE (a lease: a run that dies leaves them to be
 * retried after it), POSTs each, and records the outcome: SUCCEEDED, or the
 * next attempt time from RETRY_DELAYS_SECONDS, or FAILED after the last.
 * Delivery is at-least-once; receivers dedupe on the event id.
 *
 * Both run across tenants, so outside the tenant scope; each write names the
 * row's own tenantId.
 */

const FAN_OUT_BATCH = 200
const DELIVERY_BATCH = 10
const LEASE_MS = 5 * 60_000
const ERROR_CHARS = 500

export async function fanOutEvents(): Promise<number> {
  return withoutTenantScope(async () => await prisma.$transaction(async (tx) => {
    const events = await tx.$queryRaw<Array<{ id: string; tenantId: string; type: string }>>(Prisma.sql`
      SELECT "id", "tenantId", "type" FROM "WebhookEvent"
      WHERE "dispatchedAt" IS NULL
      ORDER BY "createdAt"
      LIMIT ${FAN_OUT_BATCH}
      FOR UPDATE SKIP LOCKED
    `)
    if (events.length === 0) return 0
    const tenantIds = [...new Set(events.map((e) => e.tenantId))]
    const endpoints = await tx.webhookEndpoint.findMany({
      where: { tenantId: { in: tenantIds }, active: true },
      select: { id: true, tenantId: true, events: true },
    })
    const rows = events.flatMap((e) => endpoints
      .filter((ep) => ep.tenantId === e.tenantId && ep.events.includes(e.type))
      .map((ep) => ({ tenantId: e.tenantId, endpointId: ep.id, eventId: e.id })))
    if (rows.length > 0) await tx.webhookDelivery.createMany({ data: rows, skipDuplicates: true })
    await tx.webhookEvent.updateMany({ where: { id: { in: events.map((e) => e.id) } }, data: { dispatchedAt: new Date() } })
    return events.length
  }))
}

async function claimDue(now: Date): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    UPDATE "WebhookDelivery" SET "nextAttemptAt" = ${new Date(now.getTime() + LEASE_MS)}
    WHERE "id" IN (
      SELECT "id" FROM "WebhookDelivery"
      WHERE "status" = 'PENDING' AND "nextAttemptAt" <= ${now}
      ORDER BY "nextAttemptAt"
      LIMIT ${DELIVERY_BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `)
  return rows.map((r) => r.id)
}

export function webhookBody(event: { id: string; type: string; createdAt: Date; data: Prisma.JsonValue }): string {
  return JSON.stringify({ id: event.id, type: event.type, createdAt: event.createdAt.toISOString(), data: event.data })
}

async function deliverOne(id: string, deps: PostDeps): Promise<"succeeded" | "retry" | "failed"> {
  const d = await prisma.webhookDelivery.findUniqueOrThrow({
    where: { id },
    include: {
      endpoint: { select: { url: true, active: true, secretSealed: true } },
      event: { select: { id: true, type: true, createdAt: true, data: true } },
    },
  })
  const now = new Date()
  const attempts = d.attempts + 1
  let outcome: { ok: boolean; status: number | null; error: string | null }
  if (!d.endpoint.active) {
    outcome = { ok: false, status: null, error: "endpoint disabled" }
  } else {
    try {
      const key = webhookSecretKey()
      if (!key) throw new Error("WEBHOOK_SECRET_KEY is not set")
      const body = webhookBody(d.event)
      outcome = await postWebhook(d.endpoint.url, body, {
        [SIGNATURE_HEADER]: signWebhookBody(openSecret(d.endpoint.secretSealed, key), body),
        "CredaFlow-Event-Id": d.event.id,
        "CredaFlow-Event-Type": d.event.type,
        "CredaFlow-Delivery-Id": d.id,
      }, deps)
    } catch (error) {
      // A local fault (no key, a secret that will not open) is recorded on the
      // delivery and retried like a failed POST, so it shows in the log.
      outcome = { ok: false, status: null, error: error instanceof Error ? error.message : String(error) }
    }
  }
  const next = outcome.ok || !d.endpoint.active ? null : nextAttemptAfter(attempts, now)
  const status = outcome.ok ? "SUCCEEDED" : next ? "PENDING" : "FAILED"
  await prisma.webhookDelivery.update({
    where: { id, tenantId: d.tenantId },
    data: {
      status,
      attempts,
      lastAttemptAt: now,
      lastResponseStatus: outcome.status,
      lastError: outcome.error?.slice(0, ERROR_CHARS) ?? null,
      deliveredAt: outcome.ok ? now : null,
      ...(next ? { nextAttemptAt: next } : {}),
    },
  })
  return outcome.ok ? "succeeded" : next ? "retry" : "failed"
}

export interface DeliveryRunResult {
  fannedOut: number
  succeeded: number
  retrying: number
  failed: number
}

// One run at a time per process: the scheduler fires every minute whether or
// not the last run finished, and overlapping runs would multiply the outbound
// concurrency. Each run is itself bounded: DELIVERY_BATCH requests at a time,
// each under postWebhook's deadline, claimed only until the time budget ends.
let running = false

export async function runWebhookDeliveries(opts: { budgetMs?: number; deps?: PostDeps } = {}): Promise<DeliveryRunResult & { skipped?: true }> {
  if (running) return { fannedOut: 0, succeeded: 0, retrying: 0, failed: 0, skipped: true }
  running = true
  try {
    return await runOnce(opts)
  } finally {
    running = false
  }
}

async function runOnce(opts: { budgetMs?: number; deps?: PostDeps }): Promise<DeliveryRunResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 45_000)
  const result: DeliveryRunResult = { fannedOut: await fanOutEvents(), succeeded: 0, retrying: 0, failed: 0 }
  await withoutTenantScope(async () => {
    while (Date.now() < deadline) {
      const ids = await claimDue(new Date())
      if (ids.length === 0) break
      const outcomes = await Promise.all(ids.map((id) => deliverOne(id, opts.deps ?? {})))
      for (const o of outcomes) {
        if (o === "succeeded") result.succeeded++
        else if (o === "retry") result.retrying++
        else result.failed++
      }
    }
  })
  return result
}
