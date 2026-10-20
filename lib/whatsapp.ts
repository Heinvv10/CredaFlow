/**
 * WhatsApp client — sends messages via VPS WA Sender (port 8083)
 * Phone format: 27821234567 (no +, no spaces)
 * JID format: 27821234567@s.whatsapp.net
 */

import { randomUUID } from "node:crypto"

export interface WaResult {
  ok: boolean
  messageId?: string
  // The WhatsApp number this message actually went out from. The unofficial
  // bridge runs a failover pool and switches numbers on its own, so without
  // this the sending number for a given NCA Section 129 notice or collections
  // message is unreconstructible. Optional because an older bridge does not
  // return it — absent means unknown, never assume the primary.
  fromNumber?: string
  simulated?: boolean
  error?: string
  providerOutcome?: "DEFINITELY_REJECTED" | "AMBIGUOUS"
}

// This allowlist is deliberately provider-specific. A 408 or 409 from the
// WA sender does not prove the downstream WhatsApp submission was rejected.
const WA_DEFINITE_REJECTION_STATUSES = new Set([
  400, 401, 403, 404, 405, 413, 415, 422, 429,
])

export function waHttpFailureOutcome(
  status: number,
): "DEFINITELY_REJECTED" | "AMBIGUOUS" {
  return WA_DEFINITE_REJECTION_STATUSES.has(status)
    ? "DEFINITELY_REJECTED"
    : "AMBIGUOUS"
}

interface WaSendOptions {
  to: string      // phone number, e.g. "27821234567" or "+27821234567"
  message: string
  signal?: AbortSignal
}

// Exported for tests so the idempotent-JID contract has direct coverage.
// Callers go through sendWhatsAppMessage which uses it internally.
export function normalizePhone(phone: string): string {
  // Idempotent: accept either a raw phone OR a fully-qualified WA JID
  // (`27821234567@s.whatsapp.net`). Without the suffix-strip, callers that
  // pass a JID get a double-suffixed JID after toJid() reapplies it →
  // `27821234567@s.whatsapp.net@s.whatsapp.net` → posts never deliver.
  let p = phone.replace(/@s\.whatsapp\.net$/i, "")
  // Strip spaces, dashes, +
  p = p.replace(/[\s\-+]/g, "")
  // SA: 0821234567 → 27821234567
  if (p.startsWith("0") && p.length === 10) p = "27" + p.slice(1)
  return p
}

function toJid(phone: string): string {
  return `${normalizePhone(phone)}@s.whatsapp.net`
}

// No default: a send with the URL unset fails rather than reaching a host the
// deployment never chose.
function getWaSenderUrl(): string | undefined {
  return process.env.WA_SENDER_URL?.trim() || undefined
}

export function isWaEnabled(): boolean {
  return process.env.WA_ENABLED === "true"
}

export async function sendWhatsAppMessage(opts: WaSendOptions): Promise<WaResult> {
  if (!isWaEnabled()) {
    return {
      ok: false,
      error: "WhatsApp disabled",
      providerOutcome: "DEFINITELY_REJECTED",
    }
  }

  if (process.env.NODE_ENV === "test" || process.env.WA_DRY_RUN === "true") {
    // Unique per call so multiple dry-run sends don't collide on
    // Message @@unique([provider, providerMessageId]) in the new-send path.
    return { ok: true, messageId: `dry-run-${randomUUID()}`, simulated: true }
  }

  const senderUrl = getWaSenderUrl()
  if (!senderUrl) {
    return {
      ok: false,
      error: "WA_SENDER_URL is not configured",
      providerOutcome: "DEFINITELY_REJECTED",
    }
  }

  const jid = toJid(opts.to)
  const url = `${senderUrl}/send-message`

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group_jid: jid, message: opts.message }),
      signal: opts.signal ?? AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error")
      return {
        ok: false,
        error: `WA Sender ${res.status}: ${text}`,
        providerOutcome: waHttpFailureOutcome(res.status),
      }
    }

    const data = await res.json() as { success: boolean; message_id?: string; from_number?: string; error?: string }
    if (!data.success) {
      return {
        ok: false,
        error: data.error ?? "WA Sender returned failure",
        providerOutcome: "DEFINITELY_REJECTED",
      }
    }

    const messageId = data.message_id?.trim()
    if (!messageId) {
      // A successful HTTP response without a provider receipt cannot support
      // a truthful SENT audit. Dispatch may have happened, so reconciliation
      // is required and automatic replay must remain blocked.
      return {
        ok: false,
        error: "WA Sender returned success without a provider message id",
        providerOutcome: "AMBIGUOUS",
      }
    }

    const fromNumber = data.from_number?.trim()
    // Absent on an older bridge — record nothing rather than guessing.
    return fromNumber ? { ok: true, messageId, fromNumber } : { ok: true, messageId }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "WA request failed",
      providerOutcome: "AMBIGUOUS",
    }
  }
}

// ── Message templates ─────────────────────────────────────────────────────────

export const WA_TEMPLATES = {
  application_submitted: (name: string, ref: string, amount: string, lenderName: string) =>
    `Hi ${name} 👋\n\nYour loan application *${ref}* for *${amount}* has been received.\n\nWe'll review it within 24 hours and be in touch. Thank you for choosing ${lenderName}.`,

  application_approved: (name: string, amount: string, ref: string) =>
    `Good news ${name}! 🎉\n\nYour loan application for *${amount}* has been *approved*.\n\nRef: ${ref}\n\nWe'll be in touch shortly to finalise the agreement.`,

  application_declined: (name: string, ref: string) =>
    `Hi ${name},\n\nUnfortunately your application *${ref}* was unsuccessful at this time.\n\nPlease contact us if you have any questions or would like to discuss alternative options.`,

  loan_disbursed: (name: string, amount: string, dueDate: string) =>
    `Hi ${name} ✅\n\nYour loan of *${amount}* has been paid to your account.\n\nYour first payment is due on *${dueDate}*. You can view your repayment schedule on the client portal.`,

  payment_due_3d: (name: string, amount: string, dueDate: string, ref: string) =>
    `Hi ${name},\n\nReminder: A payment of *${amount}* is due on *${dueDate}*.\n\nPayment reference: *${ref}*\n\nPlease ensure funds are available. Log in to the portal to pay or view your schedule.`,

  payment_due_today: (name: string, amount: string, ref: string) =>
    `Hi ${name},\n\nYour loan payment of *${amount}* is due *today*.\n\nPayment reference: *${ref}*\n\nContact us if you need assistance.`,

  payment_overdue_1d: (name: string, amount: string, ref: string) =>
    `Hi ${name},\n\n⚠️ Your payment of *${amount}* on loan *${ref}* was due yesterday.\n\nPlease pay urgently to avoid additional charges. Contact us immediately if you are experiencing difficulty.`,

  payment_overdue_7d: (name: string, amount: string, ref: string, phone: string) =>
    `URGENT - ${name}\n\nLoan *${ref}* is *7 days overdue*. Outstanding: *${amount}*.\n\nPlease contact us immediately: ${phone}\n\nFurther action will be taken if payment is not received.`,

  payment_received: (name: string, amount: string, balance: string) =>
    `Hi ${name} ✅\n\nWe've received your payment of *${amount}*.\n\nOutstanding balance: *${balance}*. Thank you!`,

  section129: (name: string, ref: string, phone: string) =>
    `Important notice for ${name} — loan *${ref}*.\n\nA Section 129 notice has been sent to your email address.\n\nPlease contact us urgently on ${phone} to resolve this matter.`,
} as const

export type WaTemplateKey = keyof typeof WA_TEMPLATES
