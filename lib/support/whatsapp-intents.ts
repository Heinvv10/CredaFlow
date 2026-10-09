export type SupportIntent = {
  /** Stable analytics id. Sent to Matomo as an event name, so it must never
   *  carry user data. */
  id: string
  label: string
  /** Pre-filled first-person text the client sends from their own WhatsApp.
   *  It appears to be written by them, so it must not promise a response
   *  time, a product, or an outcome. */
  message: string
}

/** Builds a wa.me deep-link opening the visitor's own WhatsApp with `message`
 *  pre-filled. wa.me takes bare digits, so the leading + is stripped.
 *  `e164` is the lender's `identity.publicWhatsappE164`; callers must not
 *  render a link when the lender has none. */
export function waHref(e164: string, message: string): string {
  const digits = e164.replace("+", "")
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`
}

export const WEBSITE_INTENTS: readonly SupportIntent[] = [
  {
    id: "apply",
    label: "Apply for a loan",
    message: "Hi, I'd like to apply for a loan.",
  },
  {
    id: "rates",
    label: "Rates and repayments",
    message: "Hi, I have a question about rates and repayments.",
  },
  {
    id: "insurance",
    label: "Insurance enquiry",
    message: "Hi, I'd like to know more about your insurance cover.",
  },
  {
    id: "complaint",
    label: "Log a complaint",
    message: "Hi, I'd like to log a complaint.",
  },
]

export const PORTAL_INTENTS: readonly SupportIntent[] = [
  {
    id: "account",
    label: "Help with my account",
    message: "Hi, I need help with my loan account.",
  },
  {
    id: "payment",
    label: "Payment or arrangement",
    message: "Hi, I'd like to discuss a payment or arrangement.",
  },
  {
    id: "banking",
    label: "Update banking details",
    message: "Hi, I need to update my banking details.",
  },
  {
    id: "complaint",
    label: "Log a complaint",
    message: "Hi, I'd like to log a complaint.",
  },
]
