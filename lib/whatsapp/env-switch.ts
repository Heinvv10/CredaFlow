/**
 * The ONE parser for `WA_ENABLED`, the process-level WhatsApp kill switch.
 * Pure (no imports) so lib/whatsapp.ts and the UI pages can use it without
 * pulling in the database.
 *
 *  - exactly "false" (trimmed, case-insensitive) or EMPTY: OFF.
 *  - anything else, including UNSET, "true", "TRUE", " true ": not off. The
 *    send then follows the tenant's `CommsSettings.whatsappEnabled`.
 *
 * Unset must not mean off: Cloud-only deployments never set it
 * (docs/DEPLOY-ENV.md). The Baileys bridge additionally needs `WA_SENDER_URL`,
 * which lib/whatsapp.ts enforces on its own.
 */
export function isWaEnvOff(): boolean {
  const raw = process.env.WA_ENABLED
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  return value === "" || value === "false"
}
