/**
 * Sends one servicing notice (./entity-notices.ts) to every person who acts for
 * an entity borrower (./entity-contacts.ts), through the ONE outbound entry
 * point, sendMessage() (lib/messaging/send.ts): Message row, conversation,
 * audit, and canSend's consent / opt-out / blocked-contact gate, evaluated per
 * recipient and per channel.
 *
 * Channels: EMAIL and WHATSAPP only. SMS is off by policy and is never a leg
 * here, whatever the env says (lib/messaging/.claude.md).
 *
 * Every leg is reported, never dropped: a recipient without WhatsApp, without a
 * Contact row for the value (or whose value resolves to another person's
 * Contact), or blocked by consent is an outcome with a reason.
 * A missing or unusable template row fails that channel for every recipient.
 *
 * Idempotency: one key per (occurrence, recipient, channel), so two directors
 * each get the message and a re-run of the same occurrence sends nothing new.
 */
import type { Channel, MessageTemplate } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { lookupContactByChannelValue, normaliseEmail, toWaJid } from "@/lib/contact/identity"
import { messageDeliveryOutcome } from "@/lib/messaging/delivery-outcome"
import { isDatabaseInfrastructureError } from "@/lib/ops/db-fault"
import { getCommsSettings } from "@/lib/inbox/settings"
import {
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
} from "@/lib/messaging/send"
import type { EntityContact } from "./entity-contacts"
import {
  ENTITY_EMAIL_KEY,
  ENTITY_WA_EVENT,
  entityEmailVars,
  entityWhatsAppVars,
  type EntityNoticeFacts,
  type EntityNoticeLender,
} from "./entity-notices"

export type EntityChannel = Extract<Channel, "EMAIL" | "WHATSAPP">

export type EntityLegStatus =
  | "sent"
  | "simulated"
  | "pending"
  | "reconciliation"
  | "blocked"
  | "skipped"
  | "failed"

export interface EntityLegOutcome {
  clientId: string
  channel: EntityChannel
  status: EntityLegStatus
  messageId?: string
  reason?: string
  /** A database fault that failed the leg, for a cron to rethrow; never put in a report. */
  fault?: unknown
}

export interface EntityNoticeRequest {
  tenantId: string
  loanId: string
  facts: EntityNoticeFacts
  lender: EntityNoticeLender
  recipients: EntityContact[]
  channels: EntityChannel[]
  /** the business occurrence, e.g. `reminder_1d:2026-11-01` or a payment id */
  occurrence: string
  /** Message.category */
  category: string
}

type TemplateLookup = { template: MessageTemplate } | { problem: string }

async function loadTemplate(tenantId: string, key: string, channel: EntityChannel): Promise<TemplateLookup> {
  const template = await prisma.messageTemplate.findFirst({ where: { tenantId, key, channel, active: true } })
  if (!template) {
    return { problem: `template ${key} missing/inactive — seed the default templates (seedDefaultMessageTemplates in lib/messaging/default-templates.ts)` }
  }
  // Servicing messages must run through consent, never around it.
  if (template.statutoryOverride !== false) return { problem: `template ${key} has statutoryOverride=true — refused` }
  return { template }
}

function channelValue(recipient: EntityContact, channel: EntityChannel): string | null {
  if (channel === "EMAIL") return normaliseEmail(recipient.email) || null
  return recipient.whatsapp ? toWaJid(recipient.whatsapp) || null : null
}

async function sendLeg(
  request: EntityNoticeRequest,
  recipient: EntityContact,
  channel: EntityChannel,
  template: MessageTemplate,
): Promise<EntityLegOutcome> {
  const leg = { clientId: recipient.clientId, channel }
  if (channel === "WHATSAPP" && !recipient.whatsapp) return { ...leg, status: "skipped", reason: "No WhatsApp on file" }
  const value = channelValue(recipient, channel)
  if (!value) return { ...leg, status: "failed", reason: `Unparseable ${channel} value` }
  const contact = await lookupContactByChannelValue(prisma, { tenantId: request.tenantId, channel, value })
  if (!contact) return { ...leg, status: "failed", reason: "No Contact row" }
  // The value resolves to SOMEONE ELSE's Contact (a lead, another client): their
  // consent would be checked instead of this person's, and they would read the
  // entity's loan. Refused; the reason names no number or address.
  if (contact.clientId !== recipient.clientId) {
    return { ...leg, status: "failed", reason: "Contact belongs to someone else" }
  }
  const vars = channel === "EMAIL"
    ? entityEmailVars(request.facts, request.lender, recipient)
    : entityWhatsAppVars(request.facts, request.lender, recipient)
  try {
    const message = await sendMessage({
      contactId: contact.id,
      channel,
      template,
      vars,
      toValue: value,
      toName: channel === "EMAIL" ? `${recipient.firstName} ${recipient.lastName}`.trim() : undefined,
      category: request.category,
      loanId: request.loanId,
      idempotencyKey: `entity-notice:${request.loanId}:${request.occurrence}:${recipient.clientId}:${channel}`,
    })
    const outcome = messageDeliveryOutcome(message.status)
    if (outcome === "not_sent") {
      const status = message.status === "SUPPRESSED_BY_CONSENT" ? "blocked" : "failed"
      return { ...leg, status, messageId: message.id, reason: message.status }
    }
    return { ...leg, status: outcome, messageId: message.id }
  } catch (error) {
    if (error instanceof SendBlockedError) return { ...leg, status: "blocked", reason: error.reason }
    if (error instanceof MessageReconciliationRequiredError) {
      return { ...leg, status: "reconciliation", messageId: error.messageRecord.id, reason: "delivery uncertain; automatic replay blocked" }
    }
    console.error(`[entity-dispatch] ${leg.channel} to ${leg.clientId} failed:`, error)
    return { ...leg, status: "failed", reason: "send failed; see the server log", ...(isDatabaseInfrastructureError(error) ? { fault: error } : {}) }
  }
}

export async function sendEntityNotice(request: EntityNoticeRequest): Promise<EntityLegOutcome[]> {
  const outcomes: EntityLegOutcome[] = []
  const whatsappEnabled = !request.channels.includes("WHATSAPP")
    || (await getCommsSettings(request.tenantId)).whatsappEnabled
  for (const channel of request.channels) {
    if (channel === "WHATSAPP" && !whatsappEnabled) {
      outcomes.push(...request.recipients.map((recipient) => ({
        clientId: recipient.clientId,
        channel,
        status: "blocked" as const,
        reason: "WhatsApp channel is off",
      })))
      continue
    }
    const key = channel === "EMAIL" ? ENTITY_EMAIL_KEY[request.facts.kind] : `${ENTITY_WA_EVENT[request.facts.kind]}_whatsapp`
    const lookup = await loadTemplate(request.tenantId, key, channel)
    for (const recipient of request.recipients) {
      outcomes.push("problem" in lookup
        ? { clientId: recipient.clientId, channel, status: "failed", reason: lookup.problem }
        : await sendLeg(request, recipient, channel, lookup.template))
    }
  }
  return outcomes
}

/**
 * One line for a LoanNote or cron detail: who got what, per channel. With `names`
 * (a staff-visible LoanNote) a recipient is their name; without (the cron's
 * response and logs) they are "recipient N" in order of appearance, so the report
 * names no person.
 */
export function describeEntityOutcomes(outcomes: EntityLegOutcome[], names?: Map<string, string>): string {
  if (outcomes.length === 0) return "no director, trustee or authorised signatory to message"
  const ordinal = new Map<string, number>()
  const label = (clientId: string) => {
    if (names) return names.get(clientId) ?? clientId
    if (!ordinal.has(clientId)) ordinal.set(clientId, ordinal.size + 1)
    return `recipient ${ordinal.get(clientId)}`
  }
  return outcomes
    .map((o) => `${label(o.clientId)} ${o.channel.toLowerCase()}: ${o.status}${o.reason ? ` (${o.reason})` : ""}`)
    .join("; ")
}

/** A leg that reached (or may have reached) a provider: what a LoanNote records. */
export const reachedProvider = (o: EntityLegOutcome): boolean =>
  o.status === "sent" || o.status === "simulated" || o.status === "reconciliation"
