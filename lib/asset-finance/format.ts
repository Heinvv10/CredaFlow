import { formatDate } from "@/lib/utils"
import { randsToCents } from "./money-input"

// Display formatting for the asset-finance screens. Presentation only: no
// figure is computed here. lib/utils formatZAR is left as it is because the
// NCA documents print through it and must stay byte-identical.

const NBSP = " "

/**
 * Cents as rand for a screen: "R 1,287.73", a negative "-R 1,287.73" (sign
 * before the currency). The space after "R" is non-breaking, so a narrow
 * cell never wraps the symbol away from its digits.
 */
export function formatMoney(cents: number): string {
  const digits = (Math.abs(cents) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${cents < 0 ? "-" : ""}R${NBSP}${digits}`
}

/** An ISO calendar date ("2026-06-08") as the app prints dates: "08 Jun 2026". */
export function formatIsoDate(iso: string): string {
  // Noon SAST: the calendar day cannot shift in any time zone conversion.
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? formatDate(`${iso}T12:00:00+02:00`) : iso
}

/**
 * A typed rand amount shown formatted while the field is not being edited:
 * "25000000" → "R 25,000,000.00", "-150000" → "-R 150,000.00". Text that is
 * not an amount is shown as typed, so the field's error still makes sense.
 */
export function formatMoneyInput(raw: string, allowNegative = false): string {
  const text = raw.trim()
  if (text === "") return ""
  const negative = allowNegative && text.startsWith("-")
  const cents = randsToCents(negative ? text.slice(1) : text)
  if (cents === null) return raw
  return formatMoney(negative ? -cents : cents)
}
