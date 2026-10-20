/**
 * The ONE parser for `WA_ENABLED`, the process-level WhatsApp kill switch.
 * Pure (no imports) so lib/whatsapp.ts and the UI pages can use it without
 * pulling in the database.
 *
 * Fails CLOSED on anything it does not recognise:
 *  - UNSET: not off. The send follows the tenant's
 *    `CommsSettings.whatsappEnabled`. Unset must not mean off: Cloud-only
 *    deployments never set it (docs/DEPLOY-ENV.md).
 *  - "true" (trimmed, any case): not off, same deferral.
 *  - EVERY other value is OFF: empty, "false", "0", "off", "no", typos. A
 *    kill switch that a mistyped value leaves open is not a kill switch.
 *
 * The Baileys bridge additionally needs `WA_SENDER_URL`, which lib/whatsapp.ts
 * enforces on its own.
 */
export function isWaEnvOff(): boolean {
  const raw = process.env.WA_ENABLED
  if (raw === undefined) return false
  return raw.trim().toLowerCase() !== "true"
}
