import { prisma } from "@/lib/prisma"
import type { Channel, MessageTemplate, MsgStatus } from "@prisma/client"
import { getCommsSettings } from "@/lib/inbox/settings"
import { getChannelAvailability } from "@/lib/messaging/channel-availability"
import {
  KnownDispatchPersistenceError,
  knownDispatchEvidenceFromError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
  type KnownDispatchEvidence,
} from "@/lib/messaging/send"
import {
  LEAD_OUTREACH,
  agentDisplayName,
  sanitiseOutreachVar,
  outreachTemplateKey,
  type LeadOutreachKind,
  type OutreachChannel,
} from "./lead-outreach-templates"
import { leadOutreachEligibility } from "./lead-outreach-eligibility"
import { messageOperationIdempotencyKey } from "@/lib/messaging/request-idempotency"

// Server-only: pulls in prisma. The lead-detail buttons import their labels
// from lead-outreach-templates.ts (prisma-free) instead.

export type LeadOutreachReason =
  | "NO_CONTACT"
  | "NOT_A_LOAN_ENQUIRY"
  | "LEAD_CLOSED"
  | "NO_DESTINATION"
  | "SEND_BLOCKED"
  | "SEND_FAILED"

export type LeadOutreachDeliveryOutcome =
  | "sent"
  | "simulated"
  | "pending"
  | "not_sent"
  | "reconciliation_required"

export type SendLeadOutreachResult =
  | {
      ok: true
      messageId: string
      conversationId: string
      status: MsgStatus | "RECONCILIATION_REQUIRED"
      outcome: LeadOutreachDeliveryOutcome
      knownDispatchEvidence?: KnownDispatchEvidence
    }
  | { ok: false; reason: LeadOutreachReason; detail?: string }

export function leadOutreachDeliveryOutcome(status: MsgStatus): Exclude<
  LeadOutreachDeliveryOutcome,
  "reconciliation_required"
> {
  if (["SENT", "DELIVERED", "READ"].includes(status)) return "sent"
  if (status === "SIMULATED") return "simulated"
  if (["QUEUED", "RETRYING"].includes(status)) return "pending"
  return "not_sent"
}

/**
 * Upsert the MessageTemplate backing one outreach button.
 *
 * Created on demand rather than seeded: no MessageTemplate CRUD UI exists and
 * a fresh environment has none of these rows, so a seed would have to be
 * re-run per environment. `update` re-syncs the body so editing the copy in
 * lead-outreach-templates.ts is what ships it — the DB row is a projection of
 * the code, never the source of truth.
 *
 * category/statutoryOverride are pinned here deliberately: SERVICE is the
 * approved classification (see lead-outreach-templates.ts) and
 * statutoryOverride MUST stay false — true would bypass channel opt-out, which
 * only s.129 / court process may do.
 */
export async function getOrCreateLeadOutreachTemplate(
  tenantId: string,
  kind: LeadOutreachKind,
  channel: OutreachChannel
): Promise<MessageTemplate> {
  const key = outreachTemplateKey(kind, channel)
  const body = LEAD_OUTREACH[kind].body[channel]

  return prisma.messageTemplate.upsert({
    where: { tenantId_key: { tenantId, key } },
    // subject/bodyTemplate are pinned on update too, not just create: the
    // Settings → Notifications editor upserts on the tenantId_event_channel
    // key, which matches these rows (event === key, channel WHATSAPP). More
    // importantly renderTemplate emits UNESCAPED html the instant
    // bodyTemplate is non-null (render.ts: `template.bodyTemplate ?
    // substitute(...) : null`), so "no HTML is produced" holds only while
    // this stays null — re-pin it on every send rather than trust the row.
    update: {
      body,
      active: true,
      category: "SERVICE",
      statutoryOverride: false,
      subject: null,
      bodyTemplate: null,
    },
    create: {
      tenantId,
      event: key,
      channel: channel as Channel,
      subject: null,
      body,
      // WhatsApp is body-only — bodyTemplate is the HTML/long-form path.
      bodyTemplate: null,
      active: true,
      key,
      category: "SERVICE",
      product: "GENERAL",
      statutoryOverride: false,
      language: "en",
    },
  })
}

/**
 * Vars every outreach body may reference. renderTemplate throws on a miss.
 *
 * Every value is sanitised: `leadFirstName` is typed by a member of the public
 * into the apply/contact forms, and the rendered body IS the payload — see
 * sanitiseOutreachVar. Sanitising here rather than at each call site means a
 * new template var cannot forget it.
 */
export function buildOutreachVars(a: {
  leadFirstName: string
  agentFullName: string | null
}): Record<string, string> {
  return {
    firstName: sanitiseOutreachVar(a.leadFirstName),
    // agentDisplayName sanitises internally.
    agentName: agentDisplayName(a.agentFullName),
  }
}

/**
 * One-click templated outreach to a lead.
 *
 * Sibling of sendAgentMessage (lib/messaging/agent-message.ts) — same
 * availability race-guard and error mapping — but binds a real MessageTemplate
 * so Message.templateId records *which* outreach went out, rather than
 * flattening it into the generic free-text agent_message template.
 *
 * Consent/blocked enforcement is not re-implemented here: sendMessage runs the
 * eligibility engine inside its own transaction and throws SendBlockedError.
 */
export async function sendLeadOutreach(input: {
  tenantId: string
  leadId: string
  kind: LeadOutreachKind
  channel: OutreachChannel
  agentUserId: string
  agentFullName: string | null
  operationId?: string
}): Promise<SendLeadOutreachResult> {
  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, tenantId: input.tenantId },
    select: {
      firstName: true,
      status: true,
      requestedAmount: true,
      contact: { select: { id: true } },
    },
  })
  if (!lead) return { ok: false, reason: "NO_CONTACT", detail: "lead not found" }

  // Enforced HERE, not just in the UI. The client gate is cosmetic: a lead can
  // be converted or marked lost while an agent has the detail page open, and
  // the stale page would still let them send "your application is still open"
  // to someone whose application is closed. Sibling precedent:
  // app/api/crm/leads/[id]/route.ts guards status transitions server-side.
  const eligible = leadOutreachEligibility(lead)
  if (!eligible.ok) return { ok: false, reason: eligible.reason, detail: eligible.detail }

  if (!lead.contact) {
    // Pre-F-23 leads predate the Contact directory; the backfill reconciles
    // them. Nothing to send to until then.
    return { ok: false, reason: "NO_CONTACT", detail: "this lead has no contact record yet" }
  }

  const contact = await prisma.contact.findFirst({
    where: { id: lead.contact.id, tenantId: input.tenantId },
  })
  if (!contact) return { ok: false, reason: "NO_CONTACT", detail: "contact not found" }

  const settings = await getCommsSettings(input.tenantId)
  const availability = await getChannelAvailability({
    tenantId: input.tenantId,
    contact,
    whatsappEnabled: settings.whatsappEnabled,
  })
  const avail = availability[input.channel]
  if (!avail.enabled) return { ok: false, reason: "NO_DESTINATION", detail: avail.reason }

  const template = await getOrCreateLeadOutreachTemplate(input.tenantId, input.kind, input.channel)
  const vars = buildOutreachVars({ leadFirstName: lead.firstName, agentFullName: input.agentFullName })

  try {
    const msg = await sendMessage({
      contactId: contact.id,
      channel: input.channel,
      template,
      vars,
      // Invariant from getChannelAvailability: enabled:true always carries toValue.
      toValue: avail.toValue!,
      createdById: input.agentUserId,
      category: "lead_outreach",
      idempotencyKey: messageOperationIdempotencyKey(
        `lead-outreach:${input.leadId}:${input.kind}:${input.channel}`,
        input.operationId,
      ),
    })
    return {
      ok: true,
      messageId: msg.id,
      conversationId: msg.conversationId,
      status: msg.status,
      outcome: leadOutreachDeliveryOutcome(msg.status),
    }
  } catch (err) {
    if (err instanceof SendBlockedError) {
      return { ok: false, reason: "SEND_BLOCKED", detail: err.reason }
    }
    if (err instanceof KnownDispatchPersistenceError) {
      return {
        ok: true,
        messageId: err.messageRecord.id,
        conversationId: err.messageRecord.conversationId,
        status: "RECONCILIATION_REQUIRED",
        outcome: "reconciliation_required",
        knownDispatchEvidence: knownDispatchEvidenceFromError(err),
      }
    }
    if (err instanceof MessageReconciliationRequiredError) {
      return {
        ok: true,
        messageId: err.messageRecord.id,
        conversationId: err.messageRecord.conversationId,
        status: "RECONCILIATION_REQUIRED",
        outcome: "reconciliation_required",
      }
    }
    console.error("sendLeadOutreach failed", err)
    return { ok: false, reason: "SEND_FAILED", detail: "The message could not be prepared for dispatch." }
  }
}
