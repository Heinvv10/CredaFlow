import { sastCalendarDate } from "@/lib/date/sast"

// Text and number clean-up for bureau fields (spec p32-37). Pure.

/** A SAST calendar date as CCYYMMDD, or "" (rendered as zeros) when absent. */
export function bureauDate(date: Date | null | undefined): string {
  return date ? sastCalendarDate(date).replaceAll("-", "") : ""
}

/** Cents to whole rands (spec: "Decimals are not permitted"). Never negative. */
export function wholeRands(cents: number): number {
  return Math.max(0, Math.round(cents / 100))
}

const stripAccents = (value: string) => value.normalize("NFD").replace(/[̀-ͯ]/g, "")
const collapse = (value: string) => value.replace(/\s+/g, " ").trim()

/** Names: A-Z, apostrophe, hyphen and embedded spaces only (spec p33-34). */
export function cleanName(value: string | null | undefined): string {
  return collapse(stripAccents(value ?? "").toUpperCase().replace(/[^A-Z'\- ]/g, " "))
}

/** Up to three forenames, split on spaces. */
export function forenames(firstName: string | null | undefined): [string, string, string] {
  const parts = cleanName(firstName).split(" ").filter(Boolean)
  return [parts[0] ?? "", parts[1] ?? "", parts[2] ?? ""]
}

// "Exclusion words such as unknown, as above or NA must be removed" (p34).
// NA is only dropped when it is the whole line: inside a real address it is
// far more likely to be part of a name than a placeholder.
const WHOLE_LINE_PLACEHOLDER = /^(N ?A|NONE|NIL|UNKNOWN|AS ABOVE|SAME AS ABOVE)$/
const PLACEHOLDER_PHRASE = /\b(UNKNOWN|SAME AS ABOVE|AS ABOVE)\b/g

/** Address and employer lines: 0-9, A-Z, apostrophe, hyphen, spaces (p34). */
export function cleanAddressLine(value: string | null | undefined): string {
  const cleaned = collapse(stripAccents(value ?? "").toUpperCase().replace(/[^A-Z0-9'\- ]/g, " "))
  if (WHOLE_LINE_PLACEHOLDER.test(cleaned)) return ""
  return collapse(cleaned.replace(PLACEHOLDER_PHRASE, " "))
}

/** Digits only, never zero-filled (p35). Anything else is sent blank. */
export function cleanPostalCode(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "")
  if (digits.length === 0 || digits.length > 6 || /^0+$/.test(digits)) return ""
  return digits
}

/** `0XXXXXXXXX` with no spaces (p37), or blank when it cannot be made so. */
export function cleanPhone(value: string | null | undefined): string {
  let digits = (value ?? "").replace(/\D/g, "")
  if (digits.startsWith("27") && digits.length === 11) digits = `0${digits.slice(2)}`
  return /^0\d{9}$/.test(digits) && !/^0+$/.test(digits) ? digits : ""
}

/** The layout's account number is A25 (spec p23). */
export const ACCOUNT_NUMBER_MAX = 25
/** `LN-` plus a 25-character id: what a mandated loan is referenced as. */
const MANDATED_REFERENCE = /^LN-([A-Z0-9]{25})$/

/**
 * The bureau account number for a loan reference: upper-cased, and otherwise
 * untouched unless it cannot fit. A loan paid out against a debit mandate is
 * referenced `LN-<application id>`, 28 characters; for exactly that shape the
 * `LN-` prefix is dropped, which leaves the 25-character id. Nothing else is
 * shortened: any other reference that cannot fit is held. (A hand-edited
 * reference equal to another loan's bare id would share its number; the
 * duplicate hold catches that only when both are in one file.)
 *
 * THIS RULE IS FROZEN once a live file has been sent: the account number is
 * the bureau's match key, and a loan whose number changes becomes a second
 * account on the consumer's profile. Never add a case, never change one.
 */
export function bureauAccountNumber(reference: string): string {
  // Upper-casing can lengthen or reshape non-ASCII text (ß becomes SS), so a
  // reference outside printable ASCII is passed through to be held as it is.
  if (/[^\x20-\x7E]/.test(reference)) return reference
  const upper = reference.toUpperCase()
  return MANDATED_REFERENCE.exec(upper)?.[1] ?? upper
}

/** A to Z, 0 to 9, `/`, `\`, `-`, no spaces, at most 25 characters (p158). */
export function isValidAccountNumber(accountNumber: string): boolean {
  return /^[A-Z0-9/\\-]{1,25}$/.test(accountNumber)
}
