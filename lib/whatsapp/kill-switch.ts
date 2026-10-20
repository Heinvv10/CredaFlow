import { getCommsSettings } from "@/lib/inbox/settings"
import { isWaEnvOff } from "./env-switch"

/**
 * The two WhatsApp send switches that apply to every provider, checked before
 * credentials load or any network call.
 *
 *  - `WA_ENABLED` (env, process level): see ./env-switch.ts. Fail-closed:
 *    unset or "true" defers to the tenant switch, every other value is off.
 *  - `CommsSettings.whatsappEnabled` (tenant). False = OFF.
 *
 * Reasons that mean "off" contain "WhatsApp disabled" so lib/messaging/retry.ts
 * classifies them PERMANENT: neither switch changes between cron ticks. The
 * settings-unreadable reason deliberately does NOT: a database blip is
 * transient, so where the message pipeline retries (sendMessage) it must be
 * retried, not parked as FAILED_PERMANENT. Other callers (S129 courtesy,
 * payment-reminders, send-link, the legacy collections leg) are one-shot, so
 * the text makes no promise of a retry. It also carries no exception text
 * (that can name internals and is stored).
 */
export const WA_ENV_OFF_REASON = "WhatsApp disabled: WA_ENABLED is off"
export const WA_TENANT_OFF_REASON = "WhatsApp disabled: channel is off for this tenant"
export const WA_SETTINGS_UNAVAILABLE_REASON = "WhatsApp settings temporarily unavailable"

/** Refusal reason from settings already in hand, or null when sending is allowed. */
export function whatsappRefusal(settings: { whatsappEnabled: boolean }): string | null {
  if (isWaEnvOff()) return WA_ENV_OFF_REASON
  return settings.whatsappEnabled ? null : WA_TENANT_OFF_REASON
}

/**
 * Same check for a caller without settings. An unreadable settings row fails
 * CLOSED (the send is refused): not knowing whether the tenant switched
 * WhatsApp off is not permission to send.
 */
export async function whatsappRefusalForTenant(tenantId: string): Promise<string | null> {
  if (isWaEnvOff()) return WA_ENV_OFF_REASON
  try {
    return whatsappRefusal(await getCommsSettings(tenantId))
  } catch {
    return WA_SETTINGS_UNAVAILABLE_REASON
  }
}
