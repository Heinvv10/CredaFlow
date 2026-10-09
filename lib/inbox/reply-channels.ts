import { prisma } from "@/lib/prisma"
import {
  getChannelAvailability,
  CHANNEL_BLOCKED_REASON,
  CHANNEL_OPTED_OUT_REASON,
} from "@/lib/messaging/channel-availability"
import { getCommsSettings } from "./settings"

export type ReplyChannel = "WHATSAPP" | "EMAIL"

/** Picker order, and the order every caller renders. */
export const REPLY_CHANNELS: readonly ReplyChannel[] = ["WHATSAPP", "EMAIL"]

/**
 * The ONE answer to "which channels can staff reply to this contact on".
 *
 * There were three: lib/inbox/conversations.ts read ContactIdentity,
 * lib/inbox/contact-comms.ts read the primary* fields via
 * channelAvailability, and lib/inbox/dispatch.ts read ContactIdentity again.
 * A contact with a primaryEmail but no ContactIdentity(EMAIL) row was offered
 * email by one surface and refused it by another — the composer showed a
 * channel the send would reject.
 *
 * A channel qualifies when the contact has EITHER a ContactIdentity row on it
 * OR a non-null primary destination, and is not blocked or opted out. A
 * channel that is merely switched off tenant-wide (WhatsApp toggle) still
 * qualifies: the address is on file, and the send path reports the toggle with
 * its own message. Consent beyond the SERVICE_COMMS opt-out stays where it
 * belongs, in sendMessage/canSendTx — this is about reachability, not
 * permission to send a particular message.
 */
export async function contactReplyChannels(
  tenantId: string,
  contactId: string,
): Promise<ReplyChannel[]> {
  const contact = await prisma.contact.findFirst({
    where: { id: contactId, tenantId },
    select: {
      id: true, primaryPhone: true, primaryWaJid: true, primaryEmail: true,
      blockedAt: true, status: true,
    },
  })
  if (!contact) return []

  const identities = await prisma.contactIdentity.findMany({
    where: { tenantId, contactId, channel: { in: [...REPLY_CHANNELS] } },
    select: { channel: true },
    distinct: ["channel"],
  })

  const settings = await getCommsSettings(tenantId)
  const availability = await getChannelAvailability({
    tenantId,
    contact,
    whatsappEnabled: settings.whatsappEnabled,
  })

  const primaryDestination: Record<ReplyChannel, string | null> = {
    WHATSAPP: contact.primaryWaJid ?? contact.primaryPhone,
    EMAIL: contact.primaryEmail,
  }

  return REPLY_CHANNELS.filter((channel) => {
    const reachable =
      identities.some((i) => i.channel === channel) || primaryDestination[channel] !== null
    if (!reachable) return false
    const reason = availability[channel].reason
    return reason !== CHANNEL_BLOCKED_REASON && reason !== CHANNEL_OPTED_OUT_REASON
  })
}
