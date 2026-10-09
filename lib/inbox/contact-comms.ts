import { prisma } from "@/lib/prisma"
import { getChannelAvailability } from "@/lib/messaging/channel-availability"
import { getCommsSettings } from "@/lib/inbox/settings"
import { computeWaWindow } from "./window"
import { contactReplyChannels, type ReplyChannel } from "./reply-channels"
import { MESSAGE_THREAD_INCLUDE, toThreadMessage, type ThreadMessage } from "./conversations"

export type ContactConversationSummary = {
  id: string
  channel: string
  status: string
  subject: string | null
  messageCount: number
  lastMessageAt: string | null
  loan: { id: string; reference: string } | null
  application: { id: string; reference: string } | null
}

export type TimelineMessage = ThreadMessage & { conversationId: string }

export type ContactComms = {
  conversations: ContactConversationSummary[]
  messages: TimelineMessage[]
  channelAvailability: Awaited<ReturnType<typeof getChannelAvailability>>
  waWindow: { open: boolean; expiresAt: string | null }
  /** The composer's channel picker — see lib/inbox/reply-channels.ts. */
  replyChannels: ReplyChannel[]
}

export async function getContactComms(args: {
  tenantId: string
  contactId: string
  now?: Date
}): Promise<ContactComms> {
  const now = args.now ?? new Date()

  const contact = await prisma.contact.findFirst({
    where: { id: args.contactId, tenantId: args.tenantId },
    select: {
      id: true, primaryPhone: true, primaryWaJid: true, primaryEmail: true,
      blockedAt: true, status: true, lastInboundAtByChannel: true,
    },
  })

  const convs = await prisma.conversation.findMany({
    where: { tenantId: args.tenantId, contactId: args.contactId },
    // Same key as the inbox queue (see lib/inbox/ordering.ts): lastActivityAt
    // is the later of lastInboundAt and lastOutboundAt. Ordering by
    // lastInboundAt sank every outbound-only thread to the BOTTOM of the
    // client's own history — and this tab is the surface staff use to check
    // what we sent, so a thread we only ever sent on is precisely the one they
    // came to find. Nothing was hidden (there is no `take` here), but the order
    // was wrong and ClientCommsTab auto-selects conversations[0].
    orderBy: [{ lastActivityAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
    include: {
      loan: { select: { id: true, reference: true } },
      application: { select: { id: true, reference: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        include: MESSAGE_THREAD_INCLUDE,
      },
    },
  })

  const conversations: ContactConversationSummary[] = convs.map((c) => {
    const last = c.messages[c.messages.length - 1] ?? null
    const lastAt = last?.createdAt ?? c.lastInboundAt ?? c.lastOutboundAt ?? c.createdAt
    return {
      id: c.id, channel: c.channel, status: c.status, subject: c.subject,
      messageCount: c.messages.length,
      lastMessageAt: lastAt ? lastAt.toISOString() : null,
      loan: c.loan ? { id: c.loan.id, reference: c.loan.reference } : null,
      application: c.application ? { id: c.application.id, reference: c.application.reference } : null,
    }
  })

  const messages: TimelineMessage[] = convs
    .flatMap((c) => c.messages.map((m) => ({ ...toThreadMessage(m), conversationId: c.id })))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const settings = await getCommsSettings(args.tenantId)
  const channelAvailability = contact
    ? await getChannelAvailability({ tenantId: args.tenantId, contact, whatsappEnabled: settings.whatsappEnabled })
    : { EMAIL: { enabled: false, reason: "No contact" }, WHATSAPP: { enabled: false, reason: "No contact" }, SMS: { enabled: false, reason: "No contact" } }

  const waLast = (contact?.lastInboundAtByChannel as Record<string, string> | null)?.WHATSAPP ?? null
  const window = computeWaWindow(waLast ? new Date(waLast) : null, now)

  const replyChannels = await contactReplyChannels(args.tenantId, args.contactId)

  return {
    conversations,
    messages,
    channelAvailability,
    waWindow: { open: window.open, expiresAt: window.expiresAt ? window.expiresAt.toISOString() : null },
    replyChannels,
  }
}
