import { currentConsent } from "./eligibility"
import { isSmsChannelEnabled, SMS_CHANNEL_OFF_REASON } from "./sms-channel"

export type ChannelAvail = { enabled: boolean; toValue?: string; reason?: string }

export type ChannelAvailabilityContact = {
  id: string
  primaryPhone: string | null
  primaryWaJid: string | null
  primaryEmail: string | null
  blockedAt: Date | null
  status: string
}

type ChannelKey = "EMAIL" | "WHATSAPP" | "SMS"

/**
 * The two reasons that mean "never message this contact here", as opposed to
 * "not right now" (channel toggled off, SMS dry-run). Exported so
 * lib/inbox/reply-channels.ts can exclude exactly these without re-deriving
 * blocked/opt-out state from a second source.
 */
export const CHANNEL_BLOCKED_REASON = "Do not contact"
export const CHANNEL_OPTED_OUT_REASON = "Client opted out"

/**
 * getChannelAvailability — per-channel "can we message this contact, and if
 * not, why" for the message-a-client UI. Reuses currentConsent (the
 * SERVICE_COMMS opt-out lane from eligibility.ts) rather than re-querying
 * ContactConsent directly.
 *
 * Check order per channel: blocked (blockedAt or status=BLOCKED) → no
 * identity on file → SERVICE_COMMS opted out → channel-specific gate
 * (WhatsApp toggle / SMS transport dry-run). Blocked takes precedence over
 * "no identity on file" so a do-not-contact contact always reports "Do not
 * contact" rather than a misleading "No X on file".
 */
export async function getChannelAvailability(opts: {
  tenantId: string
  contact: ChannelAvailabilityContact
  whatsappEnabled: boolean
}): Promise<Record<ChannelKey, ChannelAvail>> {
  const { contact, whatsappEnabled, tenantId } = opts
  const blocked = contact.blockedAt !== null || contact.status === "BLOCKED"

  const channels: Array<{ key: ChannelKey; toValue: string | null }> = [
    { key: "EMAIL", toValue: contact.primaryEmail },
    { key: "WHATSAPP", toValue: contact.primaryWaJid ?? contact.primaryPhone },
    { key: "SMS", toValue: contact.primaryPhone },
  ]

  const labels: Record<ChannelKey, string> = {
    EMAIL: "email",
    WHATSAPP: "WhatsApp",
    SMS: "SMS",
  }

  const result = {} as Record<ChannelKey, ChannelAvail>

  for (const { key, toValue } of channels) {
    if (blocked) {
      result[key] = toValue
        ? { enabled: false, toValue, reason: CHANNEL_BLOCKED_REASON }
        : { enabled: false, reason: CHANNEL_BLOCKED_REASON }
      continue
    }

    if (!toValue) {
      result[key] = { enabled: false, reason: `No ${labels[key]} on file` }
      continue
    }

    const consent = await currentConsent(contact.id, key, "SERVICE_COMMS", tenantId)
    if (consent?.status === "REVOKED") {
      result[key] = { enabled: false, toValue, reason: CHANNEL_OPTED_OUT_REASON }
      continue
    }

    if (key === "WHATSAPP" && !whatsappEnabled) {
      result[key] = { enabled: false, toValue, reason: "WhatsApp channel is off" }
      continue
    }

    if (key === "SMS" && !isSmsChannelEnabled()) {
      result[key] = { enabled: false, toValue, reason: SMS_CHANNEL_OFF_REASON }
      continue
    }

    result[key] = { enabled: true, toValue }
  }

  return result
}
