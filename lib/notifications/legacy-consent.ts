import { prisma } from "@/lib/prisma"
import {
  CHANNEL_BLOCKED_REASON,
  CHANNEL_OPTED_OUT_REASON,
  getChannelAvailability,
} from "@/lib/messaging/channel-availability"

export type LegacyLeg = "email" | "sms" | "whatsapp"

/** Per-leg skip reason. A leg absent from the map may be sent. */
export type LegacySuppression = Partial<Record<LegacyLeg, string>>

export const CONSENT_CHECK_FAILED_REASON = "Consent check unavailable"

/**
 * The consent gate for the legacy direct-send path in lib/notifications.ts.
 * The new-send path gets blocked / opted-out refusal from sendMessage()'s
 * eligibility lanes; the legacy path calls the providers directly and had
 * none. This runs the SAME rules (getChannelAvailability: blocked, then the
 * SERVICE_COMMS opt-out lane) and returns only the "never message this
 * contact here" verdicts.
 *
 * What it deliberately does NOT gate on, so the legacy path keeps its reach:
 *  - "No <channel> on file": the legacy leg sends to the Client row's own
 *    email/phone/whatsapp. The identities are overridden below so that
 *    getChannelAvailability cannot short-circuit to "no identity" and hide an
 *    opt-out behind it.
 *  - the SMS transport switch and the tenant WhatsApp switch: the caller
 *    already tests the SMS channel, and the WhatsApp sender enforces the
 *    tenant switch (lib/whatsapp/kill-switch.ts).
 *
 * No Contact row for the client = no block and no consent record can exist, so
 * nothing is suppressed. A lookup that THROWS fails closed: not knowing
 * whether the client opted out is not permission to message them.
 */
export async function legacySuppressedLegs(
  tenantId: string,
  client: { id: string; email: string; phone: string; whatsapp: string | null },
): Promise<LegacySuppression> {
  try {
    const contact = await prisma.contact.findFirst({
      where: { clientId: client.id, tenantId },
      select: { id: true, blockedAt: true, status: true },
    })
    if (!contact) return {}

    const availability = await getChannelAvailability({
      tenantId,
      contact: {
        id: contact.id,
        blockedAt: contact.blockedAt,
        status: contact.status,
        primaryEmail: client.email,
        primaryPhone: client.phone,
        primaryWaJid: client.whatsapp ?? client.phone,
      },
      whatsappEnabled: true,
    })

    const suppression: LegacySuppression = {}
    const legs: Array<[LegacyLeg, "EMAIL" | "SMS" | "WHATSAPP"]> = [
      ["email", "EMAIL"],
      ["sms", "SMS"],
      ["whatsapp", "WHATSAPP"],
    ]
    for (const [leg, channel] of legs) {
      const { reason } = availability[channel]
      if (reason === CHANNEL_BLOCKED_REASON || reason === CHANNEL_OPTED_OUT_REASON) {
        suppression[leg] = reason
      }
    }
    return suppression
  } catch (e) {
    console.error(`[notifications] legacy consent check failed for client ${client.id}; sending nothing:`, e)
    return { email: CONSENT_CHECK_FAILED_REASON, sms: CONSENT_CHECK_FAILED_REASON, whatsapp: CONSENT_CHECK_FAILED_REASON }
  }
}
