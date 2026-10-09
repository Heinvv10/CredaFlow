import { prisma } from "@/lib/prisma"
import type { MessageTemplate } from "@prisma/client"

type ReplyChannel = "WHATSAPP" | "EMAIL"

// Free-form agent replies reuse the established `{{body}}` passthrough idiom
// (same as collections reminders): renderTemplate substitutes vars.body verbatim,
// and the SERVICE category clears eligibility on the SERVICE_COMMS_NCA lane.
// EMAIL additionally carries a subject and an HTML body: the bodyTemplate var
// `{{bodyHtml}}` is the pre-escaped, <br>-converted body (see dispatch.ts) so
// staff-typed `<`/`&` render as text rather than markup — the same split
// lib/messaging/agent-message-template.ts uses for the message-a-client drawer.
export const AGENT_REPLY_TEMPLATE_KEY = "agent_freeform_reply"
const KEY: Record<ReplyChannel, string> = {
  WHATSAPP: AGENT_REPLY_TEMPLATE_KEY,
  EMAIL: "agent_freeform_reply_email",
}

export async function getOrCreateAgentReplyTemplate(
  tenantId: string,
  channel: ReplyChannel = "WHATSAPP",
): Promise<MessageTemplate> {
  const key = KEY[channel]
  const isEmail = channel === "EMAIL"
  return prisma.messageTemplate.upsert({
    where: { tenantId_key: { tenantId, key } },
    update: {},
    create: {
      tenantId,
      event: key,
      channel,
      subject: isEmail ? "{{subject}}" : null,
      body: "{{body}}",
      bodyTemplate: isEmail ? "{{bodyHtml}}" : null,
      active: true,
      key,
      category: "SERVICE",
      product: "GENERAL",
      statutoryOverride: false,
      language: "en",
    },
  })
}
