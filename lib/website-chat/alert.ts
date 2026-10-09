import { sendEmail } from "@/lib/email/service"
import { appBaseUrl } from "@/lib/inbox/note-mentions"
import { escapeHtml } from "@/lib/messaging/render"
import { prisma } from "@/lib/prisma"
import { safeErrorInfo } from "./http"
import { parseChatRef } from "./ref"
import { visitorLead } from "./store"

/** The EmailLog category of the alert (sendEmail stores it on every row it writes); the sweep's hourly cap counts these. */
export const CHAT_ALERT_EMAIL_CATEGORY = "website_chat_alert"

/**
 * Tells the tenant's alert address (`to`, read once per run by the sweep) that a visitor
 * asked for a person and nobody joined.
 *
 * The mail carries who to call back and a link to the thread, and nothing from the
 * chat itself: what the visitor typed stays in the inbox, behind a staff login.
 */
export async function sendChatAlertEmail(a: { tenantId: string; conversationId: string; to: string; now: Date }): Promise<"sent" | "failed"> {
  const { tenantId, conversationId, to } = a

  const { lead, ref } = await prisma.$transaction(async (tx) => {
    const thread = await tx.conversation.findFirst({ where: { id: conversationId, tenantId }, select: { subject: true } })
    return { lead: await visitorLead(tx, tenantId, conversationId), ref: parseChatRef(thread?.subject ?? null) }
  })
  const html = "<p>A website visitor asked for a person and nobody joined the chat.</p>"
    + (lead ? `<p>Name: ${escapeHtml(`${lead.firstName} ${lead.lastName}`)}<br>Call-back number: +${escapeHtml(lead.phone)}</p>` : "")
    + (ref ? `<p>Chat ref: ${escapeHtml(ref)}</p>` : "")
    + `<p><a href="${escapeHtml(`${appBaseUrl()}/inbox?conversationId=${conversationId}`)}">Open the chat</a></p>`

  try {
    const result = await sendEmail({
      tenantId, to, toName: "Team", html,
      // No name here: EmailLog stores the subject as sent.
      subject: ref ? `Website chat not answered (${ref})` : "Website chat not answered",
      category: CHAT_ALERT_EMAIL_CATEGORY, referenceId: conversationId,
      // EmailLog keeps this instead of the body, so the visitor's name and number are not stored there.
      redactedBodyPlaceholder: `Website chat alert for conversation ${conversationId}`,
    })
    return result.ok === true ? "sent" : "failed"
  } catch (error) {
    console.error("[website-chat] alert email failed", safeErrorInfo(error))
    return "failed"
  }
}
