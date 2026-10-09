// Client-safe: imported by the widget. Must never import anything that
// reaches @/lib/prisma.
export const MAX_CHAT_MESSAGE_CHARS = 1000
export const MAX_VISITOR_MESSAGES = 20
/** Visitor messages one chat may hold once staff have taken it over: no model call, so only a bound on rows. */
export const MAX_VISITOR_MESSAGES_WITH_STAFF = 100
/** Model-backed replies per tenant per SAST day. Past it every message is handed to staff. */
export const DAILY_BOT_REPLY_CAP = 300
/** Longest reply staff may send a visitor. The server refuses a longer one; the inbox composer stops the box filling past it. */
export const MAX_STAFF_REPLY_CHARS = 2000
export const CHAT_CONSENT_VERSION = "website-chat-consent-v1"
/** Subject of the lead activity startChat writes; the lead timeline links paths only in this one. */
export const CHAT_STARTED_ACTIVITY_SUBJECT = "Website chat started"
/** `brand` is the lender's trading name (identity.tradingName). */
export const chatConsentText = (brand: string) =>
  `I agree that ${brand} may keep a record of this chat and contact me on the details above about my enquiry. I understand the assistant is automated and gives general information only, not financial advice or a quote.`

/** The first word of a staff member's name, which is all a visitor is shown of it; `fallback` when there is no name. */
export function staffFirstName(name: string | null | undefined, fallback = "A consultant"): string {
  return name?.trim().split(/\s+/)[0] || fallback
}

/**
 * The line telling the visitor a staff member joined or left. It is stored as a staff line, so the
 * widget shows it as a notice when the line's text is exactly what this writes for the line's author.
 */
export type PresenceEvent = "joined" | "left"

export function presenceLine(firstName: string, event: PresenceEvent, brand: string): string {
  return `${firstName} from ${brand} has ${event} the chat.`
}

/** The label a poll gives a staff line with no usable author (store.ts), against the name the presence line falls back to (staffFirstName). */
const UNNAMED_LINE = "Consultant"

/**
 * Which presence line `text` is when `authorName` (the `name` the poll gives that staff line) wrote it,
 * or null for anything else. A staff member typing someone else's join or leave wording is not a notice.
 */
export function presenceEvent(text: string, authorName: string | undefined, brand: string): PresenceEvent | null {
  const name = authorName ?? UNNAMED_LINE
  for (const event of ["joined", "left"] as const) {
    if (text === presenceLine(name, event, brand)) return event
    if (name === UNNAMED_LINE && text === presenceLine(staffFirstName(null), event, brand)) return event
  }
  return null
}

export function chatGreeting(firstName: string, brand: string): string {
  return `Hi ${firstName}, I'm ${brand}'s automated assistant. I can answer general questions about our products, how to apply and our registration details. I can't give quotes, decide whether you qualify or look at an account. For those, I'll pass you to a consultant. What would you like to know?`
}
