import type { QuickQuoteConfig, QuickQuoteView } from "./quickquote-config"

/**
 * The options object handed to FSP Solutions' `$.fn.fspqq` plugin.
 *
 * Kept out of quickquote-config.ts on purpose: that module is imported by
 * next.config.ts before the tsconfig path aliases exist and so must stay
 * import-free. This one is imported only by QuickQuoteWidget, so it is free to
 * import types.
 */
export type QuickQuoteOptions = QuickQuoteConfig & {
  thirdparty: true
  initialView: QuickQuoteView
}

/**
 * Builds the plugin options.
 *
 * A pure function rather than an object literal inside the component, so the
 * forwarding can be tested. Each field decides where a real person's details
 * go, and a silently dropped one does not throw — FSP's script substitutes its
 * own default, and for `leadEmail` that default is their IT team.
 *
 * Lead handling stays at FSP's default. A lead is emailed on
 * `Policies/Interested` — when the visitor picks a quote and submits the
 * contact form, which is the only place name, email and cell are captured.
 *
 * `sendQuoteLead` was briefly enabled to capture every completed quote and has
 * been reverted: it fires at `Policies/_SaveQuote`, which happens BEFORE that
 * contact form exists, so the payload carries no contact details. Verified
 * against the live scripts — `_SaveQuote` sends the policy/risk object, while
 * `Interested` explicitly sends name, surname, email and cellno from
 * `PolicyHolder[0]`. Re-enabling it produces leads nobody can call.
 */
export function buildQuickQuoteOptions(
  config: QuickQuoteConfig,
  view: QuickQuoteView,
): QuickQuoteOptions {
  return {
    ...config,
    // The lender is the intermediary of record, not FSP. This is what routes the
    // lead to `elead` instead of FSP's own default mailbox.
    thirdparty: true,
    initialView: view,
  }
}
