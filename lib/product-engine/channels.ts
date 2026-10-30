/**
 * The channels an application arrives through, which a pricing rule may name (pricing.ts). A fixed list, set by the code that
 * creates the application (the portal and the website are DIGITAL, staff and the CRM are the BRANCH, the lender API is API), so
 * that nobody types the channel that earns a better price. AGENT is for a referral agent's own application, set by staff.
 */
export const PRICING_CHANNELS = ["DIGITAL", "BRANCH", "API", "AGENT"] as const
export type PricingChannel = (typeof PRICING_CHANNELS)[number]

export const isPricingChannel = (v: unknown): v is PricingChannel => typeof v === "string" && (PRICING_CHANNELS as readonly string[]).includes(v)
