/**
 * Statement money text → signed integer cents.
 *
 * Accepts the forms South African statements print: thousands grouped by a
 * space or comma, an optional R, a leading minus on either side of the R, and
 * FNB's trailing Cr (credit, positive) / Dr (debit, negative). Anything else
 * returns null: a reader must refuse a figure it cannot read exactly rather
 * than guess, because the balance check is only an oracle if every figure in
 * it is the printed one.
 */
const AMOUNT = /^(-)?R?(-)?(\d{1,3}(?:[ ,]\d{3})*|\d+)\.(\d{2})\s*(Cr|Dr)?$/i

export function parseRandToCents(text: string): number | null {
  const m = AMOUNT.exec(text.trim())
  if (!m) return null
  const [, minusBefore, minusAfter, whole, cents, crDr] = m
  const value = Number(whole.replace(/[ ,]/g, "")) * 100 + Number(cents)
  const negative = Boolean(minusBefore || minusAfter) || crDr?.toLowerCase() === "dr"
  return negative ? -value : value
}

/** Formats cents as R1 234.56 for officer-facing summaries. */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : ""
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")
  return `${sign}R${whole}.${String(abs % 100).padStart(2, "0")}`
}
