import { prisma } from "@/lib/prisma"
import type { Message } from "@prisma/client"
import {
  KnownDispatchPersistenceError,
  knownDispatchEvidenceFromError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
  type KnownDispatchEvidence,
} from "@/lib/messaging/send"
import { escapeHtml } from "@/lib/messaging/render"
import type { SendMessageOpts } from "@/lib/messaging/types"
import { getCommsSettings } from "./settings"
import { getOrCreateAgentReplyTemplate } from "./agent-reply-template"
import { messageOperationIdempotencyKey } from "@/lib/messaging/request-idempotency"
import { messageDeliveryOutcome, type MessageDeliveryOutcome } from "@/lib/messaging/delivery-outcome"
import { WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE } from "@/lib/whatsapp/send-mode"
import { computeWaWindow } from "./window"
import { contactReplyChannels, type ReplyChannel } from "./reply-channels"
import { MAX_STAFF_REPLY_CHARS } from "@/lib/website-chat/constants"
import { sendStaffChatReply } from "@/lib/website-chat/staff"

export type { ReplyChannel }

export type AgentReplyInput = {
  tenantId: string
  conversationId: string
  agentUserId: string
  /** Recorded on the audit row of a website-chat reply. */
  agentEmail?: string
  text: string
  /**
   * Which channel this specific reply goes out on. Absent = server default
   * (latest inbound message's channel, else Conversation.channel). One thread
   * now carries every channel, so this is per-reply, not per-thread.
   */
  channel?: ReplyChannel
  operationId?: string
}

// CHANNEL_DISABLED is the channel-neutral "can't send on this channel right now"
// code (WhatsApp toggle off, email not SMTP-configured, unsupported channel);
// `detail` carries the human-readable specifics for the composer fallback banner.
export type AgentReplyResult =
  | { ok: true; message: Message; outcome: Exclude<MessageDeliveryOutcome, "not_sent">; reconciliationRequired?: true; knownDispatchEvidence?: KnownDispatchEvidence }
  | { ok: false; reason: "CHANNEL_DISABLED" | "CONVERSATION_NOT_FOUND" | "NO_DESTINATION" | "SEND_BLOCKED" | "SEND_FAILED" | "OUTSIDE_WINDOW"; detail?: string }

const OUTSIDE_WINDOW_DETAIL =
  "This contact is outside the 24h WhatsApp window — pick an approved template to reply."

type LoadedConversation = {
  id: string
  channel: string
  lastInboundAt: Date | null
  contact: {
    id: string
    primaryWaJid: string | null
    primaryPhone: string | null
    primaryEmail: string | null
    lastInboundAtByChannel: unknown
  }
}

const CHANNEL_LABEL: Record<ReplyChannel, string> = { WHATSAPP: "WhatsApp", EMAIL: "email" }

/**
 * Which channel a reply goes out on when the caller did not pick one: the
 * channel of the newest INBOUND message on the thread. Reply-where-they-wrote.
 * Falls back to Conversation.channel for a thread we opened outbound-first.
 */
export async function defaultReplyChannel(
  tenantId: string,
  conversationId: string,
  fallback: string,
): Promise<string> {
  const lastInbound = await prisma.message.findFirst({
    where: { tenantId, conversationId, direction: "INBOUND" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { channel: true },
  })
  return lastInbound?.channel ?? fallback
}

export async function dispatchAgentReply(input: AgentReplyInput): Promise<AgentReplyResult> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: input.conversationId, tenantId: input.tenantId },
    select: {
      id: true,
      channel: true,
      lastInboundAt: true,
      contact: {
        select: {
          id: true, primaryWaJid: true, primaryPhone: true, primaryEmail: true,
          lastInboundAtByChannel: true,
        },
      },
    },
  })
  if (!conversation) return { ok: false, reason: "CONVERSATION_NOT_FOUND" }
  if (conversation.channel === "CHATBOT") return sendChatReply(input)

  const resolved = input.channel
    ?? (await defaultReplyChannel(input.tenantId, conversation.id, conversation.channel))
  if (resolved !== "WHATSAPP" && resolved !== "EMAIL") {
    return { ok: false, reason: "CHANNEL_DISABLED", detail: `Replies are not supported on ${resolved} conversations.` }
  }
  const channel: ReplyChannel = resolved

  // The thread is channel-agnostic now, so "does this contact have an address
  // on the channel you picked" is a real question with a real wrong answer.
  // Same helper the composer's picker is built from (lib/inbox/reply-channels.ts),
  // so a channel the UI offers is never one this gate refuses.
  const allowed = await contactReplyChannels(input.tenantId, conversation.contact.id)
  if (!allowed.includes(channel)) {
    return { ok: false, reason: "NO_DESTINATION", detail: `This contact has no ${CHANNEL_LABEL[channel]} identity on file.` }
  }

  if (channel === "WHATSAPP") {
    // Meta's rule, not ours: no free text outside the 24h service window.
    // Same source of truth as the composer indicator (lib/inbox/conversations.ts)
    // and the real sender (lib/whatsapp-cloud.ts): lastInboundAtByChannel.WHATSAPP
    // only. Conversation.lastInboundAt is channel-agnostic (email inbound writes
    // it too), so it must NOT be used as a fallback here — no WhatsApp entry
    // means the window is closed, full stop.
    const waLast = (conversation.contact.lastInboundAtByChannel as Record<string, string> | null)?.WHATSAPP ?? null
    const lastInboundAt = waLast ? new Date(waLast) : null
    if (!computeWaWindow(lastInboundAt, new Date()).open) {
      return { ok: false, reason: "OUTSIDE_WINDOW", detail: OUTSIDE_WINDOW_DETAIL }
    }
    return sendWhatsAppReply(input, conversation)
  }
  return sendEmailReply(input, conversation)
}

// A website chat reply is a row the visitor's chat window reads: nothing is sent
// through a provider, so it never reaches sendMessage, whatever channel was asked for.
async function sendChatReply(input: AgentReplyInput): Promise<AgentReplyResult> {
  const r = await sendStaffChatReply({
    tenantId: input.tenantId, conversationId: input.conversationId, staffUserId: input.agentUserId, staffEmail: input.agentEmail, text: input.text, now: new Date(),
    idempotencyKey: messageOperationIdempotencyKey(`agent-reply:${input.conversationId}:CHATBOT`, input.operationId),
  })
  if (r.ok) return { ok: true, message: r.message, outcome: "sent" }
  if (r.reason === "CONVERSATION_NOT_FOUND") return { ok: false, reason: "CONVERSATION_NOT_FOUND" }
  if (r.reason === "EMPTY") return { ok: false, reason: "SEND_FAILED", detail: "Type a message first." }
  if (r.reason === "TOO_LONG") return { ok: false, reason: "SEND_FAILED", detail: `Replies are limited to ${MAX_STAFF_REPLY_CHARS} characters.` }
  return { ok: false, reason: "CHANNEL_DISABLED", detail: r.reason === "CLOSED" ? "This chat has ended." : "Join the chat before replying." }
}

async function sendWhatsAppReply(input: AgentReplyInput, conv: LoadedConversation): Promise<AgentReplyResult> {
  const settings = await getCommsSettings(input.tenantId)
  if (!settings.whatsappEnabled) return { ok: false, reason: "CHANNEL_DISABLED", detail: "WhatsApp channel is disabled." }

  const toValue = conv.contact.primaryWaJid ?? conv.contact.primaryPhone
  if (!toValue) return { ok: false, reason: "NO_DESTINATION" }

  const template = await getOrCreateAgentReplyTemplate(input.tenantId, "WHATSAPP")
  return finishSend(input, conv.id, {
    contactId: conv.contact.id,
    channel: "WHATSAPP",
    template,
    vars: { body: input.text },
    toValue,
    conversationId: conv.id,
    createdById: input.agentUserId,
    category: "agent_reply",
    idempotencyKey: messageOperationIdempotencyKey(
      `agent-reply:${conv.id}:WHATSAPP`,
      input.operationId,
    ),
  })
}

async function sendEmailReply(input: AgentReplyInput, conv: LoadedConversation): Promise<AgentReplyResult> {
  const config = await prisma.emailConfig.findUnique({
    where: { tenantId: input.tenantId },
    select: { active: true, provider: true },
  })
  if (!config || !config.active) {
    return { ok: false, reason: "CHANNEL_DISABLED", detail: "Email is not configured for this tenant." }
  }
  // MS Graph outbound stores a synthetic Message-ID (lib/email/service.ts) so the
  // customer's reply can't be thread-matched back to our message yet. Gate email
  // replies to SMTP until the real internetMessageId is captured post-send
  // (follow-up). A tenant on IMAP_SMTP is unaffected.
  if (config.provider === "MSGRAPH") {
    return { ok: false, reason: "CHANNEL_DISABLED", detail: "Email replies require SMTP; MS Graph threading is a follow-up." }
  }

  const toValue = conv.contact.primaryEmail
  if (!toValue) return { ok: false, reason: "NO_DESTINATION" }

  // Build RFC 5322 threading headers from the thread's email Message-IDs.
  // In-Reply-To points at the last INBOUND message; References lists the whole
  // chain so the customer's mail client keeps the conversation together.
  const thread = await prisma.message.findMany({
    where: { tenantId: input.tenantId, conversationId: conv.id, channel: "EMAIL", providerMessageId: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { direction: true, providerMessageId: true, subject: true },
  })
  const references = thread.map((m) => m.providerMessageId).filter((id): id is string => !!id)
  const lastInbound = [...thread].reverse().find((m) => m.direction === "INBOUND")
  const subjectSource = lastInbound?.subject ?? thread[thread.length - 1]?.subject ?? null

  const template = await getOrCreateAgentReplyTemplate(input.tenantId, "EMAIL")
  return finishSend(input, conv.id, {
    contactId: conv.contact.id,
    channel: "EMAIL",
    template,
    vars: {
      subject: replySubject(subjectSource),
      body: input.text,
      // Escape + newline→<br> so the rendered HTML email keeps line breaks and
      // never interprets staff-typed `<`/`&` as markup (mirrors agent-message.ts).
      bodyHtml: escapeHtml(input.text).replace(/\n/g, "<br>"),
    },
    toValue,
    conversationId: conv.id,
    createdById: input.agentUserId,
    category: "agent_reply",
    inReplyTo: lastInbound?.providerMessageId ?? undefined,
    references: references.length > 0 ? references : undefined,
    idempotencyKey: messageOperationIdempotencyKey(
      `agent-reply:${conv.id}:EMAIL`,
      input.operationId,
    ),
  })
}

// Prefix "Re: " once, preserving an existing reply prefix. Threading is carried
// by the In-Reply-To/References headers, not the subject — this is cosmetic
// continuity for the customer's mail client.
function replySubject(source: string | null): string {
  const base = (source ?? "").trim()
  if (!base) return "Re: your message"
  return /^re:/i.test(base) ? base : `Re: ${base}`
}

async function finishSend(
  input: AgentReplyInput,
  conversationId: string,
  opts: SendMessageOpts,
): Promise<AgentReplyResult> {
  try {
    const message = await sendMessage(opts)
    const outcome = messageDeliveryOutcome(message.status)
    if (outcome === "not_sent") {
      // Some automatic-retry channels (see lib/messaging/send.ts) resolve a
      // durable terminal Message instead of throwing on a definite provider
      // rejection. Detect the outside-window code here too so the composer
      // gets the "pick a template" prompt regardless of which shape fires.
      if (message.errorMessage?.includes(WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE)) {
        return { ok: false, reason: "OUTSIDE_WINDOW", detail: OUTSIDE_WINDOW_DETAIL }
      }
      return {
        ok: false,
        reason: "SEND_FAILED",
        detail: `Message ${message.id} is ${message.status} and was not sent.`,
      }
    }
    // sendMessage atomically advances Conversation.lastOutboundAt using the
    // provider acceptance timestamp for every fresh/retry completion. Do not
    // overwrite that evidence here with the later HTTP request time.
    return { ok: true, message, outcome }
  } catch (err) {
    if (err instanceof SendBlockedError) {
      return { ok: false, reason: "SEND_BLOCKED", detail: err.reason }
    }
    // Sender-level rejection path: some dispatch failures throw straight out
    // of sendMessage (e.g. an externally-owned dispatch) rather than resolving
    // a terminal Message. Detect the same outside-window code here.
    if (err instanceof Error && err.message.includes(WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE)) {
      return { ok: false, reason: "OUTSIDE_WINDOW", detail: OUTSIDE_WINDOW_DETAIL }
    }
    if (err instanceof KnownDispatchPersistenceError) {
      return {
        ok: true,
        message: err.messageRecord,
        outcome: "pending",
        reconciliationRequired: true,
        knownDispatchEvidence: knownDispatchEvidenceFromError(err),
      }
    }
    if (err instanceof MessageReconciliationRequiredError) {
      return { ok: true, message: err.messageRecord, outcome: "pending", reconciliationRequired: true }
    }
    throw err
  }
}
