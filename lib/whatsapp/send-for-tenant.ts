import { getCommsSettings } from "@/lib/inbox/settings"
import { isWaEnabled, sendWhatsAppMessage, type WaResult } from "@/lib/whatsapp"
import { sendWhatsAppCloudMessage } from "@/lib/whatsapp-cloud"

/**
 * Send a WhatsApp message over whichever transport the tenant is actually
 * configured for.
 *
 * `lib/messaging/providers.ts` already forks on `CommsSettings.waProvider`,
 * but two live callers predate it and called the Baileys bridge directly:
 * the payment-reminders cron and the `section129_sent` courtesy notification
 * (which is absent from `NEW_SEND_FLAGS`, so it never took the flag-gated
 * cutover the other six events did). After the 2026-08-11 WA_CLOUD cutover
 * that is a transport nothing routes through — the bridge has no numbers
 * paired — so those two sends fail no matter how many Meta templates are
 * approved. A caller that never asks Meta cannot be fixed by registering
 * templates at Meta.
 *
 * This is deliberately the TRANSPORT only, not the `sendMessage()` pipeline.
 * Moving these callers onto that pipeline (Message rows, retry, eligibility,
 * template selection) is the migration `NEW_SEND_FLAGS` exists to stage, and
 * doing it wholesale to NCA borrower comms is not a change to bundle here.
 *
 * Note what this does and does NOT buy. It takes no template, so on WA_CLOUD
 * `hasApprovedTemplate` is always false and any send outside Meta's 24h window
 * fails with `WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE`. Registering templates at Meta
 * will NOT by itself clear that — no `WaTemplateRef` can reach this function.
 * What changes is:
 *   - in-window sends now actually work (they could not against a dead bridge);
 *   - out-of-window sends fail against the live provider with an accurate
 *     reason, instead of against a transport that is never coming back.
 * Restoring business-initiated reminders end to end needs these callers on
 * `sendMessage()`, which selects and fills a template — the migration
 * NEW_SEND_FLAGS stages. That is deliberately not bundled here.
 */
export async function sendWhatsAppForTenant(opts: {
  tenantId: string
  to: string
  message: string
  /** Lets the Cloud sender read the 24h service window. Without it every send
   *  resolves to a null window and fails as out-of-window. */
  contactId?: string
  signal?: AbortSignal
}): Promise<WaResult> {
  // The env kill-switch used to come free from inside sendWhatsAppMessage.
  // sendWhatsAppCloudMessage has no equivalent, so routing to it would have
  // silently bypassed WA_ENABLED — and this cron runs on EVERY non-client
  // container, staging included. With a prod-restored staging DB
  // (whatsappEnabled=true, waProvider=WA_CLOUD, sealed creds) that means real
  // WhatsApp messages to real borrowers from staging.
  if (!isWaEnabled()) {
    return { ok: false, error: "WhatsApp disabled", providerOutcome: "DEFINITELY_REJECTED" }
  }

  let provider: string
  try {
    provider = (await getCommsSettings(opts.tenantId)).waProvider
  } catch (e) {
    // Both callers inspect a WaResult and one writes its audit LoanNote from
    // it, so this must never throw: a throw would be recorded as "not sent"
    // by one and would abort the cron's whole remaining batch in the other.
    return {
      ok: false,
      error: e instanceof Error ? `comms settings unavailable: ${e.message}` : "comms settings unavailable",
      providerOutcome: "DEFINITELY_REJECTED",
    }
  }

  if (provider === "WA_CLOUD") {
    return sendWhatsAppCloudMessage({
      tenantId: opts.tenantId,
      to: opts.to,
      message: opts.message,
      contactId: opts.contactId,
      signal: opts.signal,
    })
  }

  return sendWhatsAppMessage({ to: opts.to, message: opts.message, signal: opts.signal })
}
