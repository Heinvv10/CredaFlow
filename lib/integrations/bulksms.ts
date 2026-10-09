/**
 * BulkSMS integration — SMS and WhatsApp via BulkSMS REST API
 */

import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { isSmsChannelEnabled, SMS_CHANNEL_OFF_REASON } from "@/lib/messaging/sms-channel"

interface SmsOptions {
  tenantId: string
  to: string
  message: string
  signal?: AbortSignal
}

export interface SmsResult {
  ok: boolean
  messageId?: string
  simulated?: boolean
  error?: string
  providerOutcome?: "DEFINITELY_REJECTED" | "AMBIGUOUS"
}

// Only responses that prove BulkSMS rejected the submitted request are safe
// to replay automatically. Timeout/conflict responses (notably 408/409) can
// arrive after provider acceptance and therefore require reconciliation.
const BULKSMS_DEFINITE_REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 405, 413, 415, 422, 429,
])

export function bulkSmsHttpFailureOutcome(
  status: number,
): "DEFINITELY_REJECTED" | "AMBIGUOUS" {
  return BULKSMS_DEFINITE_REJECTION_STATUSES.has(status)
    ? "DEFINITELY_REJECTED"
    : "AMBIGUOUS"
}

async function getCredentials(tenantId: string): Promise<{ username: string; password: string } | null> {
  try {
    const config = await prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { bulkSmsKey: true },
    })
    if (!config?.bulkSmsKey) return null
    const [username, password] = config.bulkSmsKey.split(":")
    if (!username || !password) return null
    return { username, password }
  } catch {
    return null
  }
}

function isDryRun(): boolean {
  return process.env.NODE_ENV === "test" || process.env.BULKSMS_DRY_RUN === "true"
}

async function sendBulkSms(
  opts: SmsOptions,
  routingGroup?: string
): Promise<SmsResult> {
  if (isDryRun()) {
    // Must stay the first branch — `lib/integrations/bulksms.test.ts`
    // mocks `@/lib/prisma` with an empty object, so any DB call before
    // this point throws TypeError under test.
    //
    // Unique per call so multiple dry-run sends don't collide on
    // Message @@unique([provider, providerMessageId]) in the new-send path.
    return { ok: true, messageId: `dry-run-${randomUUID()}`, simulated: true }
  }

  const creds = await getCredentials(opts.tenantId)
  if (!creds) {
    return {
      ok: false,
      error: "BulkSMS not configured",
      providerOutcome: "DEFINITELY_REJECTED",
    }
  }

  const body: Record<string, unknown> = {
    to: opts.to,
    body: opts.message,
  }
  if (routingGroup) {
    body.routingGroup = routingGroup
  }

  try {
    const token = Buffer.from(`${creds.username}:${creds.password}`).toString("base64")
    const res = await fetch("https://api.bulksms.com/v1/messages", {
      method: "POST",
      headers: {
        Authorization: `Basic ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })

    if (!res.ok) {
      const errText = await res.text()
      return {
        ok: false,
        error: `BulkSMS error ${res.status}: ${errText}`,
        providerOutcome: bulkSmsHttpFailureOutcome(res.status),
      }
    }

    const data = await res.json() as unknown
    const rawMessageId = Array.isArray(data)
      ? (data[0] as { id?: unknown } | undefined)?.id
      : data && typeof data === "object"
        ? (data as { id?: unknown }).id
        : undefined
    const messageId = typeof rawMessageId === "string"
      ? rawMessageId.trim()
      : typeof rawMessageId === "number" && Number.isFinite(rawMessageId)
        ? String(rawMessageId)
        : ""
    if (!messageId) {
      // The provider boundary was crossed and the response was successful,
      // but there is no provider-issued receipt we can truthfully persist.
      // Hold this as ambiguous instead of inventing a provider id.
      return {
        ok: false,
        error: "BulkSMS returned success without a provider message id",
        providerOutcome: "AMBIGUOUS",
      }
    }
    return { ok: true, messageId }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "BulkSMS request failed",
      providerOutcome: "AMBIGUOUS",
    }
  }
}

export async function sendSms(opts: SmsOptions): Promise<SmsResult> {
  // Transport-level backstop for the SMS channel being off. The callsites in
  // lib/collections/reminders.ts, lib/notifications.ts and the send-link
  // routes each skip their own SMS leg — that is what produces the honest
  // per-leg accounting — but a documented invariant is not a control, and a
  // callsite added later would otherwise bypass every one of those skips.
  // This sits below all of them, including lib/messaging/providers.ts, which
  // is how sendMessage() reaches BulkSMS.
  //
  // Returns a DEFINITELY_REJECTED failure rather than throwing: a throw here
  // would abort a cron mid-batch, and nothing was submitted to the provider,
  // so a definite rejection is the truthful outcome. Deliberately placed
  // ABOVE the dry-run short-circuit — the point is to stop the synthetic
  // success, not to produce one.
  //
  // sendWhatsApp() shares sendBulkSms() but not this guard: the two channels
  // are switched independently and WhatsApp is live.
  if (!isSmsChannelEnabled()) {
    return {
      ok: false,
      error: SMS_CHANNEL_OFF_REASON,
      providerOutcome: "DEFINITELY_REJECTED",
    }
  }
  return sendBulkSms(opts)
}

export async function sendWhatsApp(opts: SmsOptions): Promise<SmsResult> {
  return sendBulkSms(opts, "WHATSAPP")
}
