/**
 * Webhook event types. Written by the outbox triggers of migration
 * 20261014150000_lender_api_webhooks and mirrored by its
 * WebhookEndpoint_events_check: change all three together.
 */
export const WEBHOOK_EVENTS = [
  "application.created",
  "application.status_changed",
  "loan.disbursed",
  "payment.received",
] as const

export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number]

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  "application.created": "An application is created (any channel)",
  "application.status_changed": "An application changes status",
  "loan.disbursed": "A loan is disbursed (booked)",
  "payment.received": "A payment is received on a loan",
}

export function parseWebhookEvents(value: unknown): WebhookEventType[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (!value.every((v) => typeof v === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(v))) return null
  return [...new Set(value as WebhookEventType[])]
}

/**
 * Retry schedule: the delay before attempt n+1 after n failed attempts. After
 * the last entry the delivery is FAILED (8 attempts over about 45 hours).
 */
export const RETRY_DELAYS_SECONDS = [60, 300, 1800, 7200, 21600, 43200, 86400] as const
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1

/** When to try again after `attempts` failed attempts, or null when it is FAILED. */
export function nextAttemptAfter(attempts: number, now: Date): Date | null {
  if (attempts >= MAX_ATTEMPTS) return null
  return new Date(now.getTime() + RETRY_DELAYS_SECONDS[attempts - 1] * 1000)
}
