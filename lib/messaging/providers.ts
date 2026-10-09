import { sendEmail, type EmailAttachment } from "@/lib/email/service"
import { sendSms } from "@/lib/integrations/bulksms"
import { sendWhatsAppMessage } from "@/lib/whatsapp"
import { sendWhatsAppCloudMessage } from "@/lib/whatsapp-cloud"
import type { Channel, Provider } from "@prisma/client"
import type { RenderedTemplate } from "./render"
import type { WaTemplateRef } from "@/lib/whatsapp/template-components"

export type DispatchOpts = {
  tenantId: string
  toValue: string
  category?: string
  // Email-only. Display name on the To header, and the EmailLog `toName`
  // column. Dropping it made these sends anonymous in the log.
  toName?: string
  // Email-only. The EmailLog `referenceId` column — what
  // /api/email/logs?referenceId=<id> filters on. Dropping it made the
  // per-application email history unqueryable.
  referenceId?: string
  listUnsubscribeUrl?: string
  // Email-only. Body-secrecy placeholder for `redactStoredBody` templates:
  // the provider receives the true body, EmailLog stores this instead.
  redactedBodyPlaceholder?: string
  // Email-only. Ignored for SMS/WhatsApp channels — callers that supply
  // these for non-email channels get them silently dropped (no error, no
  // throw) so the same opts shape can be reused across channels without
  // a per-channel guard at every call site.
  replyTo?: string
  attachments?: EmailAttachment[]
  // Email-only RFC 5322 threading headers. Ignored for SMS/WhatsApp.
  inReplyTo?: string
  references?: string[]
  onProviderDispatchStart?: () => void
  signal?: AbortSignal
  // WhatsApp Cloud only. contactId lets the cloud sender read the 24h service
  // window; waTemplate is the approved-template fallback for out-of-window sends.
  contactId?: string
  waTemplate?: WaTemplateRef
}

export type DispatchResult =
  | {
      simulated?: false
      acceptedAt: Date
      providerMessageId?: string
      // Channel value the message actually left from (WA_UNOFFICIAL only, and
      // only when the bridge reports it). The bridge pool fails over between
      // numbers on its own, so this is the sole per-message record of which
      // number carried an NCA notice. Absent = unknown, never assumed.
      fromValue?: string
      evidenceReference?: string
      auxiliaryPersistenceError?: string
    }
  | { simulated: true; simulationReceiptId: string }

export type ProviderFailureOutcome = "DEFINITELY_REJECTED" | "AMBIGUOUS"

export class ProviderDispatchError extends Error {
  outcome: ProviderFailureOutcome

  constructor(message: string, outcome: ProviderFailureOutcome) {
    super(message)
    this.name = "ProviderDispatchError"
    this.outcome = outcome
  }
}

export function providerFailureOutcome(error: unknown): ProviderFailureOutcome {
  return error instanceof ProviderDispatchError ? error.outcome : "AMBIGUOUS"
}

function requireProviderMessageId(
  value: string | undefined,
  providerLabel: string,
): string {
  const id = value?.trim()
  if (!id) {
    throw new ProviderDispatchError(
      `${providerLabel} returned success without a provider message id`,
      "AMBIGUOUS",
    )
  }
  return id
}

export async function dispatch(
  channel: Channel,
  provider: Provider,
  rendered: RenderedTemplate,
  opts: DispatchOpts,
): Promise<DispatchResult> {
  switch (channel) {
    case "EMAIL": {
      if (provider !== "MSGRAPH" && provider !== "SMTP") {
        throw new ProviderDispatchError(
          `Unsupported email provider reservation: ${provider}`,
          "DEFINITELY_REJECTED",
        )
      }
      const r = await sendEmail({
        tenantId: opts.tenantId,
        to: opts.toValue,
        toName: opts.toName,
        subject: rendered.subject ?? "",
        // The PROVIDER always gets the true rendered body. Only the EmailLog
        // row is redacted, via redactedBodyPlaceholder below.
        html: rendered.html ?? rendered.text,
        text: rendered.text,
        category: opts.category,
        referenceId: opts.referenceId,
        listUnsubscribeUrl: opts.listUnsubscribeUrl,
        redactedBodyPlaceholder: opts.redactedBodyPlaceholder,
        replyTo: opts.replyTo,
        attachments: opts.attachments,
        inReplyTo: opts.inReplyTo,
        references: opts.references,
        onProviderDispatchStart: opts.onProviderDispatchStart,
        signal: opts.signal,
        expectedProvider: provider,
      })
      if (!r.ok) {
        throw new ProviderDispatchError(
          r.error ?? "email provider returned ok:false",
          r.providerOutcome === "DEFINITELY_REJECTED"
            ? "DEFINITELY_REJECTED"
            : "AMBIGUOUS",
        )
      }
      if (!r.acceptedAt) {
        throw new ProviderDispatchError(
          "email provider accepted the message without an acceptance timestamp",
          "AMBIGUOUS",
        )
      }
      if (r.provider !== provider) {
        throw new ProviderDispatchError(
          "Email provider result contradicts the durable provider reservation",
          "DEFINITELY_REJECTED",
        )
      }
      if (provider === "MSGRAPH") {
        const evidenceReference = r.providerEvidenceReference?.trim()
        const requestScopedEvidence = evidenceReference && (
          /^MSGRAPH_CLIENT_REQUEST_ID:[0-9a-f-]{36}$/i.test(evidenceReference) ||
          /^MSGRAPH_REQUEST_ID:[^;\s]+;CLIENT_REQUEST_ID:[0-9a-f-]{36}$/i.test(evidenceReference)
        )
        if (!requestScopedEvidence) {
          throw new ProviderDispatchError(
            "Microsoft Graph accepted the message without request-scoped provider evidence",
            "AMBIGUOUS",
          )
        }
        return {
          acceptedAt: r.acceptedAt,
          evidenceReference,
          ...(r.emailLogPersistenceError
            ? { auxiliaryPersistenceError: r.emailLogPersistenceError }
            : {}),
        }
      }
      return {
        providerMessageId: requireProviderMessageId(r.messageId, "SMTP provider"),
        acceptedAt: r.acceptedAt,
        ...(r.emailLogPersistenceError
          ? { auxiliaryPersistenceError: r.emailLogPersistenceError }
          : {}),
      }
    }
    case "SMS": {
      opts.onProviderDispatchStart?.()
      const r = await sendSms({
        tenantId: opts.tenantId,
        to: opts.toValue,
        message: rendered.text,
        signal: opts.signal,
      })
      if (!r.ok) {
        throw new ProviderDispatchError(
          r.error ?? "sms provider returned ok:false",
          r.providerOutcome === "DEFINITELY_REJECTED"
            ? "DEFINITELY_REJECTED"
            : "AMBIGUOUS",
        )
      }
      if (r.simulated === true) {
        return {
          simulationReceiptId: requireProviderMessageId(r.messageId, "SMS simulation"),
          simulated: true,
        }
      }
      return {
        providerMessageId: requireProviderMessageId(r.messageId, "SMS provider"),
        acceptedAt: new Date(),
      }
    }
    case "WHATSAPP": {
      opts.onProviderDispatchStart?.()
      let r
      if (provider === "WA_CLOUD") {
        r = await sendWhatsAppCloudMessage({
          tenantId: opts.tenantId,
          to: opts.toValue,
          message: rendered.text,
          // Forward the contact + approved-template ref so the cloud sender can
          // read the 24h service window and send a template out-of-window.
          // Dropping these makes every WA_CLOUD send resolve to null-window →
          // WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE (a total send failure).
          contactId: opts.contactId,
          template: opts.waTemplate,
          signal: opts.signal,
        })
      } else if (provider === "WA_UNOFFICIAL") {
        r = await sendWhatsAppMessage({
          to: opts.toValue,
          message: rendered.text,
          signal: opts.signal,
        })
      } else {
        throw new ProviderDispatchError(
          `Unsupported WhatsApp provider reservation: ${provider}`,
          "DEFINITELY_REJECTED",
        )
      }
      if (!r.ok) {
        throw new ProviderDispatchError(
          r.error ?? "whatsapp provider returned ok:false",
          r.providerOutcome === "DEFINITELY_REJECTED"
            ? "DEFINITELY_REJECTED"
            : "AMBIGUOUS",
        )
      }
      if (r.simulated === true) {
        return {
          simulationReceiptId: requireProviderMessageId(r.messageId, "WhatsApp simulation"),
          simulated: true,
        }
      }
      return {
        providerMessageId: requireProviderMessageId(r.messageId, "WhatsApp provider"),
        acceptedAt: new Date(),
        ...(r.fromNumber ? { fromValue: r.fromNumber } : {}),
      }
    }
    case "VOICE":
      throw new Error("voice channel dispatch is not supported in PR-2 (lands in S5)")
    case "MANUAL":
      throw new Error("manual channel does not dispatch — internal notes are written directly")
    case "ALL_CHANNELS":
      throw new Error("ALL_CHANNELS is a consent-scope sentinel, not a real channel")
    case "CHATBOT":
      throw new Error("chatbot channel dispatch is not supported in PR-2")
    default: {
      const _exhaustive: never = channel
      throw new Error(`unsupported channel: ${_exhaustive}`)
    }
  }
}
