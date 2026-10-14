import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { openSecret } from "@/lib/crypto/secret-box"
import { nextAttemptAfter } from "@/lib/lender-api/webhooks/events"
import { SIGNATURE_HEADER, signWebhookBody } from "@/lib/lender-api/webhooks/signing"
import { postWebhook, type PostDeps, type PostResult } from "@/lib/lender-api/webhooks/post"
import { webhookSecretKey } from "@/lib/lender-api/webhooks/endpoints"
import { recordEndpointOutcome } from "@/lib/lender-api/webhooks/circuit-breaker"

/**
 * The webhook cron (app/api/cron/webhook-deliveries), in two steps:
 *
 * fanOutEvents — each undispatched WebhookEvent (written by the outbox
 * triggers) becomes one PENDING WebhookDelivery per active endpoint of its
 * tenant subscribed to its type, and is marked dispatched, in one transaction.
 * Rows are claimed FOR UPDATE SKIP LOCKED, so two runs never fan out one event.
 *
 * deliver — claims due PENDING deliveries in small batches by pushing their
 * nextAttemptAt forward by LEASE (a lease: a run that dies leaves them to be
 * retried after it), POSTs each, and records the outcome: SUCCEEDED, or the
 * next attempt time from RETRY_DELAYS_SECONDS, or FAILED after the last.
 * Delivery is at-least-once; receivers dedupe on the event id.
 *
 * Fairness: a batch takes at most PER_ENDPOINT_PER_BATCH deliveries of one
 * endpoint and PER_TENANT_PER_BATCH of one lender, and a run at most
 * PER_ENDPOINT_PER_RUN and PER_TENANT_PER_RUN, so neither one slow receiver
 * nor one lender with many endpoints can starve the rest. Deliveries of a
 * paused endpoint (circuit breaker, circuit-breaker.ts) or of a lender that
 * is not ACTIVE are not claimed and wait, PENDING, without spending attempts.
 *
 * Only the result of a real POST counts: an attempt, and a step toward the
 * circuit breaker. A local fault (no WEBHOOK_SECRET_KEY, a secret that will
 * not open) is recorded on the delivery and retried after LOCAL_FAULT_RETRY_MS
 * without spending an attempt or touching the breaker, and a destination
 * refused here (SSRF guard) spends an attempt but does not trip the breaker.
 *
 * Both steps run across tenants, so outside the tenant scope; each write names
 * the row's own tenantId.
 */

const FAN_OUT_BATCH = 200
const DELIVERY_BATCH = 10
export const PER_ENDPOINT_PER_BATCH = 2
export const PER_ENDPOINT_PER_RUN = 25
export const PER_TENANT_PER_BATCH = 5
export const PER_TENANT_PER_RUN = 50
const LEASE_MS = 5 * 60_000
const LOCAL_FAULT_RETRY_MS = 5 * 60_000
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

type Claimed = { id: string; endpointId: string; tenantId: string }

/**
 * Pick candidates without locks (the window functions need none), then take
 * them with an UPDATE that re-checks they are still due: of two runs choosing
 * the same row, the second finds it leased and skips it.
 */
async function claimDue(now: Date, exhaustedEndpoints: string[], exhaustedTenants: string[]): Promise<Claimed[]> {
  return prisma.$queryRaw<Claimed[]>(Prisma.sql`
    WITH candidates AS (
      SELECT "id", "nextAttemptAt" FROM (
        SELECT d."id", d."nextAttemptAt",
               row_number() OVER (PARTITION BY d."endpointId" ORDER BY d."nextAttemptAt", d."id") AS per_endpoint,
               row_number() OVER (PARTITION BY d."tenantId" ORDER BY d."nextAttemptAt", d."id") AS per_tenant
        FROM "WebhookDelivery" d
        JOIN "WebhookEndpoint" e ON e."id" = d."endpointId"
        JOIN "Tenant" t ON t."id" = d."tenantId"
        WHERE d."status" = 'PENDING' AND d."nextAttemptAt" <= ${now}
          AND e."pausedAt" IS NULL AND t."status" = 'ACTIVE'
          AND NOT (d."endpointId" = ANY (${exhaustedEndpoints}::text[]))
          AND NOT (d."tenantId" = ANY (${exhaustedTenants}::text[]))
      ) ranked
      WHERE per_endpoint <= ${PER_ENDPOINT_PER_BATCH} AND per_tenant <= ${PER_TENANT_PER_BATCH}
      ORDER BY "nextAttemptAt"
      LIMIT ${DELIVERY_BATCH}
    )
    UPDATE "WebhookDelivery" w SET "nextAttemptAt" = ${new Date(now.getTime() + LEASE_MS)}
    FROM candidates c
    WHERE w."id" = c."id" AND w."status" = 'PENDING' AND w."nextAttemptAt" <= ${now}
    RETURNING w."id", w."endpointId", w."tenantId"
  `)
}

export function webhookBody(event: { id: string; type: string; createdAt: Date; data: Prisma.JsonValue }): string {
  return JSON.stringify({ id: event.id, type: event.type, createdAt: event.createdAt.toISOString(), data: event.data })
}

type Outcome = "succeeded" | "retry" | "failed" | "deferred"

async function deliverOne(id: string, deps: PostDeps): Promise<Outcome> {
  const d = await prisma.webhookDelivery.findUniqueOrThrow({
    where: { id },
    include: {
      endpoint: { select: { url: true, active: true, secretSealed: true } },
      event: { select: { id: true, type: true, createdAt: true, data: true } },
    },
  })
  const now = new Date()
  let outcome: PostResult
  if (!d.endpoint.active) {
    outcome = { ok: false, status: null, error: "endpoint disabled", attempted: false }
  } else {
    let headers: Record<string, string>
    const body = webhookBody(d.event)
    try {
      const key = webhookSecretKey()
      if (!key) throw new Error("WEBHOOK_SECRET_KEY is not set")
      headers = {
        [SIGNATURE_HEADER]: signWebhookBody(openSecret(d.endpoint.secretSealed, key), body),
        "CredaFlow-Event-Id": d.event.id,
        "CredaFlow-Event-Type": d.event.type,
        "CredaFlow-Delivery-Id": d.id,
      }
    } catch (error) {
      // A local fault: nothing was sent, so no attempt is spent and the
      // endpoint's breaker is not touched. Recorded on the delivery, retried later.
      const message = error instanceof Error ? error.message : String(error)
      console.warn("[webhooks] delivery deferred by a local fault", { deliveryId: d.id, error: message })
      await prisma.webhookDelivery.update({
        where: { id, tenantId: d.tenantId },
        data: { lastError: `not sent: ${message}`.slice(0, ERROR_CHARS), nextAttemptAt: new Date(now.getTime() + LOCAL_FAULT_RETRY_MS) },
      })
      return "deferred"
    }
    outcome = await postWebhook(d.endpoint.url, body, headers, deps)
    if (outcome.attempted) await recordEndpointOutcome({ id: d.endpointId, tenantId: d.tenantId }, outcome.ok, outcome.error)
  }
  const attempts = d.attempts + 1
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
  deferred: number
}

// One run at a time per process: the scheduler fires every minute whether or
// not the last run finished, and overlapping runs would multiply the outbound
// concurrency. Each run is itself bounded: DELIVERY_BATCH requests at a time,
// each under postWebhook's deadline, claimed only until the time budget ends.
// Across replicas, safety comes from the database (SKIP LOCKED and the lease).
let running = false

export async function runWebhookDeliveries(opts: { budgetMs?: number; deps?: PostDeps } = {}): Promise<DeliveryRunResult & { skipped?: true }> {
  if (running) return { fannedOut: 0, succeeded: 0, retrying: 0, failed: 0, deferred: 0, skipped: true }
  running = true
  try {
    return await runOnce(opts)
  } finally {
    running = false
  }
}

const over = (counts: Map<string, number>, cap: number) => [...counts].filter(([, n]) => n >= cap).map(([id]) => id)

async function runOnce(opts: { budgetMs?: number; deps?: PostDeps }): Promise<DeliveryRunResult> {
  const deadline = Date.now() + (opts.budgetMs ?? 45_000)
  const result: DeliveryRunResult = { fannedOut: await fanOutEvents(), succeeded: 0, retrying: 0, failed: 0, deferred: 0 }
  const perEndpoint = new Map<string, number>()
  const perTenant = new Map<string, number>()
  await withoutTenantScope(async () => {
    while (Date.now() < deadline) {
      const claimed = await claimDue(new Date(), over(perEndpoint, PER_ENDPOINT_PER_RUN), over(perTenant, PER_TENANT_PER_RUN))
      if (claimed.length === 0) break
      for (const c of claimed) {
        perEndpoint.set(c.endpointId, (perEndpoint.get(c.endpointId) ?? 0) + 1)
        perTenant.set(c.tenantId, (perTenant.get(c.tenantId) ?? 0) + 1)
      }
      const outcomes = await Promise.all(claimed.map((c) => deliverOne(c.id, opts.deps ?? {})))
      for (const o of outcomes) result[o === "succeeded" ? "succeeded" : o === "retry" ? "retrying" : o]++
    }
  })
  return result
}
