import { normaliseEmail, normalisePhone } from "@/lib/contact/identity"

export type ChatStartFields = { firstName: string; lastName: string; phone: string; email: string }
export type ChatStartValidation =
  | { ok: true; fields: ChatStartFields }
  | { ok: false; errors: Record<string, string> }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// After NFC: letters (any script), apostrophe, full stop, space and hyphen only. No \p{M}:
// NFC composes real accents (Zoë), so a leftover combining mark is smuggling.
const NAME_RE = /^[\p{L}'. -]{2,80}$/u
// Invisible code points that are not \p{Cf}: variation selectors and Hangul fillers (\p{Lo}).
const HIDDEN_RE = /[\uFE00-\uFE0F\u{E0100}-\u{E01EF}\u115F\u1160\u3164\uFFA0]/u
const MAX_FIRST_NAME_CHARS = 30

function cleanName(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(/[\u2019\u02BC]/g, "'") // iOS smart apostrophe, modifier apostrophe: O’Brien, N’Dou
    .replace(/\p{Cf}/gu, "") // zero-width joiners and other invisible format characters
    .replace(/\s+/g, " ")
    .trim()
}

function isValidName(name: string, firstName: string): boolean {
  return NAME_RE.test(name) && !HIDDEN_RE.test(name)
    && (name.match(/\p{L}/gu)?.length ?? 0) >= 2 && firstName.length <= MAX_FIRST_NAME_CHARS
}

export function validateChatStart(input: Record<string, unknown>): ChatStartValidation {
  const errors: Record<string, string> = {}
  // NUL and half surrogate pairs first, as for a message: Postgres refuses a NUL in text.
  const text = (v: unknown) => (typeof v === "string" ? cleanChatText(v) : "")
  const name = cleanName(text(input.name))
  const [firstName, ...rest] = name.split(" ")
  const rawPhone = text(input.phone)
  const rawEmail = text(input.email)

  if (!isValidName(name, firstName)) errors.name = "Please enter your name."
  const phone = normalisePhone(rawPhone)
  if (!phone) errors.phone = "Please enter a valid South African cell number."
  if (!EMAIL_RE.test(rawEmail) || rawEmail.length > 254) errors.email = "Please enter a valid email address."
  if (input.consent !== true) errors.consent = "Please tick the box to continue."
  if (Object.keys(errors).length > 0) return { ok: false, errors }

  return { ok: true, fields: { firstName, lastName: rest.join(" ") || "—", phone, email: normaliseEmail(rawEmail) } }
}

// Postgres refuses a NUL in text, and half a surrogate pair is not valid UTF-8.
const UNSTORABLE_RE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** A visitor's message as it can be stored and shown: no NUL, no unpaired surrogate, trimmed. */
export function cleanChatText(raw: string): string {
  return raw.replace(UNSTORABLE_RE, "").trim()
}
