import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { openSecret } from "@/lib/crypto/secret-box"
import { nextAttemptAfter } from "@/lib/lender-api/webhooks/events"
import { SIGNATURE_HEADER, signWebhookBody } from "@/lib/lender-api/webhooks/signing"
import { postWebhook, type PostDeps } from "@/lib/lender-api/webhooks/post"
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
 * endpoint and a run at most PER_ENDPOINT_PER_RUN, so one slow or failing
 * receiver cannot starve the others; deliveries of a paused endpoint (circuit
 * breaker, circuit-breaker.ts) or of a lender that is not ACTIVE are not
 * claimed at all and wait, PENDING, without spending attempts.
 *
 * Both steps run across tenants, so outside the tenant scope; each write names
 * the row's own tenantId.
 */

const FAN_OUT_BATCH = 200
const DELIVERY_BATCH = 10
export const PER_ENDPOINT_PER_BATCH = 2
export const PER_ENDPOINT_PER_RUN = 25
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

/**
 * Pick candidates without locks (the window function needs none), then take
 * them with an UPDATE that re-checks they are still due: of two runs choosing
 * the same row, the second finds it leased and skips it.
 */
async function claimDue(now: Date, exhausted: string[]): Promise<Array<{ id: string; endpointId: string }>> {
  return prisma.$queryRaw<Array<{ id: string; endpointId: string }>>(Prisma.sql`
    WITH candidates AS (
      SELECT "id", "nextAttemptAt" FROM (
        SELECT d."id", d."nextAttemptAt",
               row_number() OVER (PARTITION BY d."endpointId" ORDER BY d."nextAttemptAt", d."id") AS rn
        FROM "WebhookDelivery" d
        JOIN "WebhookEndpoint" e ON e."id" = d."endpointId"
        JOIN "Tenant" t ON t."id" = d."tenantId"
        WHERE d."status" = 'PENDING' AND d."nextAttemptAt" <= ${now}
          AND e."pausedAt" IS NULL AND t."status" = 'ACTIVE'
          AND NOT (d."endpointId" = ANY (${exhausted}::text[]))
      ) ranked
      WHERE rn <= ${PER_ENDPOINT_PER_BATCH}
      ORDER BY "nextAttemptAt"
      LIMIT ${DELIVERY_BATCH}
    )
    UPDATE "WebhookDelivery" w SET "nextAttemptAt" = ${new Date(now.getTime() + LEASE_MS)}
    FROM candidates c
    WHERE w."id" = c."id" AND w."status" = 'PENDING' AND w."nextAttemptAt" <= ${now}
    RETURNING w."id", w."endpointId"
  `)
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
    await recordEndpointOutcome({ id: d.endpointId, tenantId: d.tenantId }, outcome.ok, outcome.error)
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
  const perEndpoint = new Map<string, number>()
  await withoutTenantScope(async () => {
    while (Date.now() < deadline) {
      const exhausted = [...perEndpoint].filter(([, n]) => n >= PER_ENDPOINT_PER_RUN).map(([id]) => id)
      const claimed = await claimDue(new Date(), exhausted)
      if (claimed.length === 0) break
      for (const c of claimed) perEndpoint.set(c.endpointId, (perEndpoint.get(c.endpointId) ?? 0) + 1)
      const outcomes = await Promise.all(claimed.map((c) => deliverOne(c.id, opts.deps ?? {})))
      for (const o of outcomes) {
        if (o === "succeeded") result.succeeded++
        else if (o === "retry") result.retrying++
        else result.failed++
      }
    }
  })
  return result
}
