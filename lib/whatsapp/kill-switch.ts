import { getCommsSettings } from "@/lib/inbox/settings"

/**
 * The two WhatsApp send switches that apply to every provider, checked before
 * credentials load or any network call.
 *
 *  - `WA_ENABLED` (env, process level). Explicit "false" - or any value that
 *    is not "true" - is OFF. UNSET is NOT off: Cloud-only deployments never
 *    set it (docs/DEPLOY-ENV.md lists it under the bridge), so unset defers to
 *    the per-tenant switch. The Baileys bridge still needs WA_ENABLED="true"
 *    to send at all (`isWaEnabled()` in lib/whatsapp.ts); it also needs
 *    WA_SENDER_URL, so it is inert unless an operator opted in.
 *  - `CommsSettings.whatsappEnabled` (tenant). False = OFF.
 *
 * Reasons contain "WhatsApp disabled" so lib/messaging/retry.ts classifies the
 * failure PERMANENT: neither switch changes between cron ticks.
 */
export function isWaEnvKillSwitchOn(): boolean {
  const raw = process.env.WA_ENABLED?.trim().toLowerCase()
  if (!raw) return false
  return raw !== "true"
}

export const WA_ENV_OFF_REASON = "WhatsApp disabled: WA_ENABLED is off"
export const WA_TENANT_OFF_REASON = "WhatsApp disabled: channel is off for this tenant"

/** Refusal reason from settings already in hand, or null when sending is allowed. */
export function whatsappRefusal(settings: { whatsappEnabled: boolean }): string | null {
  if (isWaEnvKillSwitchOn()) return WA_ENV_OFF_REASON
  return settings.whatsappEnabled ? null : WA_TENANT_OFF_REASON
}

/**
 * Same check for a caller without settings. An unreadable settings row fails
 * CLOSED: not knowing whether the tenant switched WhatsApp off is not
 * permission to send.
 */
export async function whatsappRefusalForTenant(tenantId: string): Promise<string | null> {
  if (isWaEnvKillSwitchOn()) return WA_ENV_OFF_REASON
  try {
    return whatsappRefusal(await getCommsSettings(tenantId))
  } catch (e) {
    return `WhatsApp disabled: comms settings unavailable (${e instanceof Error ? e.message : "unknown error"})`
  }
}
