/**
 * Rands typed into a form ("1 250 000.50", "R1,250,000") to integer cents, or
 * null if it is not an amount with at most two decimals. String arithmetic,
 * so no binary-float rounding.
 */
export function randsToCents(input: string): number | null {
  const cleaned = input.replace(/^\s*R/i, "").replace(/[\s,]/g, "")
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
  return Number.isSafeInteger(cents) ? cents : null
}
