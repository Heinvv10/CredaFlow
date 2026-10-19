/**
 * WhatsApp Cloud API (official Meta Graph) sender.
 * Mirrors the WaResult contract of lib/whatsapp.ts so lib/messaging/dispatch
 * treats WA_CLOUD and WA_UNOFFICIAL identically. Meta enforces the 24h
 * customer-service window: free-form text only within 24h of the contact's
 * last inbound message (see lib/whatsapp/send-mode.ts); outside it, only an
 * approved template may be sent, or the call fails with
 * WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE before any HTTP request is made.
 */
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { isWaEnabled, normalizePhone, waHttpFailureOutcome, type WaResult } from "./whatsapp"
import { getWabaCreds } from "./whatsapp-cloud-config"
import { resolveWaSendMode, WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE } from "./whatsapp/send-mode"
import type { WaTemplateRef } from "./whatsapp/template-components"

interface CloudSendOptions {
  tenantId: string
  to: string
  message: string
  contactId?: string
  template?: WaTemplateRef
  signal?: AbortSignal
}

function graphVersion(): string {
  return process.env.WHATSAPP_GRAPH_VERSION ?? "v23.0"
}

/**
 * Isolated so the 24h-window read is the only DB touch in this module.
 * `Contact` is tenant-scoped (see lib/tenant-scope.ts): the query must carry
 * an explicit tenantId or the tenant-scope Prisma extension throws
 * TenantScopeError when called outside a runWithTenant ALS frame. This
 * sender's contract is "never throw" — a failed window read degrades SAFE
 * to "outside window" (null), which forces a template send instead of a
 * free-text send that would violate Meta's 24h rule.
 */
async function readWaWindow(tenantId: string, contactId: string | undefined): Promise<Date | null> {
  if (!contactId) return null
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, tenantId },
      select: { lastInboundAtByChannel: true },
    })
    const raw = (contact?.lastInboundAtByChannel as Record<string, string> | null)?.WHATSAPP
    return raw ? new Date(raw) : null
  } catch {
    return null
  }
}

export async function sendWhatsAppCloudMessage(opts: CloudSendOptions): Promise<WaResult> {
  if (process.env.NODE_ENV === "test" || process.env.WA_DRY_RUN === "true") {
    return { ok: true, messageId: `dry-run-${randomUUID()}`, simulated: true }
  }

  // The env kill switch, as sendWhatsAppMessage has it: without this check
  // WA_ENABLED=false stopped the unofficial sender but not the Cloud API.
  if (!isWaEnabled()) {
    return { ok: false, error: "WhatsApp disabled", providerOutcome: "DEFINITELY_REJECTED" }
  }

  let creds
  try {
    creds = await getWabaCreds(opts.tenantId)
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "WABA credentials unavailable",
      providerOutcome: "DEFINITELY_REJECTED",
    }
  }

  const lastInboundAt = await readWaWindow(opts.tenantId, opts.contactId)
  const hasApprovedTemplate = opts.template?.providerStatus === "APPROVED"
  const decision = resolveWaSendMode({ lastInboundAt, hasApprovedTemplate, now: new Date() })

  if (decision.mode === "error") {
    return { ok: false, error: WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE, providerOutcome: "DEFINITELY_REJECTED" }
  }

  const messageBody =
    decision.mode === "template" && opts.template
      ? {
          messaging_product: "whatsapp",
          to: normalizePhone(opts.to),
          type: "template" as const,
          template: {
            name: opts.template.name,
            language: { code: opts.template.language },
            components: opts.template.components,
          },
        }
      : {
          messaging_product: "whatsapp",
          to: normalizePhone(opts.to),
          type: "text" as const,
          text: { body: opts.message },
        }

  const url = `https://graph.facebook.com/${graphVersion()}/${creds.phoneNumberId}/messages`

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(messageBody),
      signal: opts.signal ?? AbortSignal.timeout(15000),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "unknown error")
      return {
        ok: false,
        error: `WhatsApp Cloud ${res.status}: ${text}`,
        providerOutcome: waHttpFailureOutcome(res.status),
      }
    }

    const data = (await res.json()) as { messages?: Array<{ id?: string }> }
    const messageId = data.messages?.[0]?.id?.trim()
    if (!messageId) {
      return {
        ok: false,
        error: "WhatsApp Cloud returned success without a provider message id",
        providerOutcome: "AMBIGUOUS",
      }
    }
    return { ok: true, messageId }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "WhatsApp Cloud request failed",
      providerOutcome: "AMBIGUOUS",
    }
  }
}
