import { prisma } from "@/lib/prisma"
import { getCommsSettings } from "@/lib/inbox/settings"
import { getLenderIdentity } from "@/lib/config/identity"
import { getChannelAvailability } from "./channel-availability"
import { getOrCreateAgentMessageTemplate } from "./agent-message-template"
import {
  KnownDispatchPersistenceError,
  knownDispatchEvidenceFromError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
  type KnownDispatchEvidence,
} from "./send"
import { escapeHtml } from "./render"
import type { EmailAttachment } from "@/lib/email/service"
import { messageOperationIdempotencyKey } from "./request-idempotency"
import { messageDeliveryOutcome, type MessageDeliveryOutcome } from "./delivery-outcome"
import type { MsgStatus } from "@prisma/client"

export type AgentSendReason =
  | "CHANNEL_OPTED_OUT"
  | "BLOCKED"
  | "NO_DESTINATION"
  | "WHATSAPP_DISABLED"
  | "SMS_NOT_ENABLED"
  | "NO_IDENTITY"
  | "SEND_BLOCKED"
  | "SEND_FAILED"

export type SendAgentMessageInput = {
  tenantId: string
  contactId: string
  channel: "EMAIL" | "WHATSAPP" | "SMS"
  text: string
  subject?: string
  attachments?: EmailAttachment[]
  agentUserId: string
  loanId?: string
  operationId?: string
}

export type SendAgentMessageResult =
  | { ok: true; messageId: string; conversationId: string; status: MsgStatus; outcome: Exclude<MessageDeliveryOutcome, "not_sent">; reconciliationRequired?: true; knownDispatchEvidence?: KnownDispatchEvidence }
  | { ok: false; reason: AgentSendReason; detail?: string }

/**
 * sendAgentMessage — staff-initiated free-text send to a contact, on
 * whichever channel the agent picked in the compose drawer.
 *
 * The drawer already disables channels the contact can't receive, so the
 * `getChannelAvailability` check here is a race guard (settings/consent can
 * change between the drawer render and submit) rather than the primary UX
 * gate — we surface its human-readable `reason` as `detail` under the single
 * `NO_DESTINATION` code rather than re-deriving a fine-grained reason code
 * from that text.
 */
export async function sendAgentMessage(input: SendAgentMessageInput): Promise<SendAgentMessageResult> {
  if (input.attachments && input.channel !== "EMAIL") {
    return { ok: false, reason: "NO_DESTINATION", detail: "attachments are email-only" }
  }

  const contact = await prisma.contact.findFirst({ where: { id: input.contactId, tenantId: input.tenantId } })
  if (!contact) {
    return { ok: false, reason: "NO_DESTINATION", detail: "contact not found" }
  }

  const settings = await getCommsSettings(input.tenantId)
  const availability = await getChannelAvailability({
    tenantId: input.tenantId,
    contact,
    whatsappEnabled: settings.whatsappEnabled,
  })

  const avail = availability[input.channel]
  if (!avail.enabled) {
    return { ok: false, reason: "NO_DESTINATION", detail: avail.reason }
  }

  const template = await getOrCreateAgentMessageTemplate(input.tenantId, input.channel)

  // `body` feeds the plain-text template var (unescaped, as-typed by the
  // agent). `bodyHtml` feeds the EMAIL bodyTemplate var only — HTML-escaped
  // with newlines converted to <br> so the rendered email doesn't interpret
  // staff-typed `<`/`&` as markup or collapse line breaks. Keeping these as
  // distinct vars means neither substitution double-escapes the other.
  const vars: Record<string, string> = input.channel === "EMAIL"
    ? {
        subject: input.subject ?? `A message from ${(await getLenderIdentity(input.tenantId)).tradingName}`,
        body: input.text,
        bodyHtml: escapeHtml(input.text).replace(/\n/g, "<br>"),
      }
    : { body: input.text }

  try {
    const msg = await sendMessage({
      contactId: input.contactId,
      channel: input.channel,
      template,
      vars,
      // Invariant from getChannelAvailability: enabled:true always carries toValue.
      toValue: avail.toValue!,
      createdById: input.agentUserId,
      category: "agent_message",
      loanId: input.loanId,
      attachments: input.channel === "EMAIL" ? input.attachments : undefined,
      idempotencyKey: messageOperationIdempotencyKey(
        `agent-message:${input.contactId}:${input.channel}`,
        input.operationId,
      ),
    })
    const outcome = messageDeliveryOutcome(msg.status)
    if (outcome === "not_sent") {
      return {
        ok: false,
        reason: "SEND_FAILED",
        detail: `Message ${msg.id} is ${msg.status} and was not sent.`,
      }
    }
    return { ok: true, messageId: msg.id, conversationId: msg.conversationId, status: msg.status, outcome }
  } catch (err) {
    if (err instanceof SendBlockedError) {
      return { ok: false, reason: "SEND_BLOCKED", detail: err.reason }
    }
    if (err instanceof KnownDispatchPersistenceError) {
      return {
        ok: true,
        messageId: err.messageRecord.id,
        conversationId: err.messageRecord.conversationId,
        status: err.messageRecord.status,
        outcome: "pending",
        reconciliationRequired: true,
        knownDispatchEvidence: knownDispatchEvidenceFromError(err),
      }
    }
    if (err instanceof MessageReconciliationRequiredError) {
      return {
        ok: true,
        messageId: err.messageRecord.id,
        conversationId: err.messageRecord.conversationId,
        status: err.messageRecord.status,
        outcome: "pending",
        reconciliationRequired: true,
      }
    }
    // Any other throw is a real dispatch failure (provider error, DB write
    // failure, etc.) — surface it as ok:false rather than letting it
    // propagate to an uncaught 500 in the route handler. Log the real error
    // server-side; don't leak raw provider/DB error strings to the client.
    console.error("sendAgentMessage failed", err)
    return { ok: false, reason: "SEND_FAILED", detail: "The message could not be prepared for dispatch." }
  }
}
