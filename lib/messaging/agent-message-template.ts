import { prisma } from "@/lib/prisma"
import type { MessageTemplate, Channel } from "@prisma/client"

type AgentChannel = "EMAIL" | "WHATSAPP" | "SMS"
const KEY: Record<AgentChannel, string> = {
  EMAIL: "agent_message_email",
  WHATSAPP: "agent_message_whatsapp",
  SMS: "agent_message_sms",
}

// Free-text, staff-initiated SERVICE message. SERVICE category clears
// eligibility on the SERVICE_COMMS_NCA lane (blocked only on opt-out /
// do-not-contact). Email carries a subject; WA/SMS are body-only.
export async function getOrCreateAgentMessageTemplate(tenantId: string, channel: AgentChannel): Promise<MessageTemplate> {
  const key = KEY[channel]
  return prisma.messageTemplate.upsert({
    where: { tenantId_key: { tenantId, key } },
    update: {
      bodyTemplate: channel === "EMAIL" ? "{{bodyHtml}}" : null,
    },
    create: {
      tenantId,
      event: key,
      channel: channel as Channel,
      subject: channel === "EMAIL" ? "{{subject}}" : null,
      body: "{{body}}",
      // EMAIL gets an explicit HTML template so the dispatched email body is
      // the pre-escaped, <br>-converted `bodyHtml` var (see agent-message.ts)
      // rather than falling back to the raw plain-text body as unescaped HTML.
      bodyTemplate: channel === "EMAIL" ? "{{bodyHtml}}" : null,
      active: true,
      key,
      category: "SERVICE",
      product: "GENERAL",
      statutoryOverride: false,
      language: "en",
    },
  })
}
