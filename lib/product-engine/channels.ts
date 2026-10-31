/**
 * The channels an application arrives through, which a pricing rule may name (pricing.ts). A fixed list, set by the code that
 * creates the application (the portal and the website are DIGITAL, staff and the CRM are the BRANCH, the lender API is API) and never typed
 * or changed by a person, so that nobody picks the channel that earns a better price.
 */
export const PRICING_CHANNELS = ["DIGITAL", "BRANCH", "API"] as const
export type PricingChannel = (typeof PRICING_CHANNELS)[number]

export const isPricingChannel = (v: unknown): v is PricingChannel => typeof v === "string" && (PRICING_CHANNELS as readonly string[]).includes(v)

/** The channels a customer applies through on their own: they show and schedule monthly instalments only, so no structured schedule is approved for them. */
export const CUSTOMER_CHANNELS: readonly PricingChannel[] = ["DIGITAL", "API"]
