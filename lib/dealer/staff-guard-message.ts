/**
 * The sentence a dealer-portal guard trigger raised (SQLSTATE 23514), read
 * out of whatever Prisma error class wrapped it, so a staff refusal says what
 * the database refused instead of answering 500. Matches only the RAISE text
 * of the payable-run and bank-account guards (migrations
 * 20261019120100_dealer_portal, 20261019120200_dealer_portal_hardening); any
 * other error is null and the caller rethrows it.
 */
import { isCheckViolation } from "@/lib/disbursement/guard-violation"

const SENTENCE_STARTS = ["A payable run", "A run's line", "A run holds", "A line joins", "An EARNED line", "A dealer bank account"]

function chain(error: unknown): string {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    parts.push(current.message)
    const meta = (current as { meta?: { message?: unknown } }).meta
    if (typeof meta?.message === "string") parts.push(meta.message)
    current = (current as { cause?: unknown }).cause
  }
  return parts.join("\n")
}

export function dealerGuardSentence(error: unknown): string | null {
  if (!isCheckViolation(error)) return null
  const text = chain(error)
  const starts = SENTENCE_STARTS.map((start) => text.indexOf(start)).filter((at) => at >= 0)
  if (starts.length === 0) return null
  // The RAISE text ends at the line end or, inside a quoted driver message, at its closing quote or backtick.
  return text.slice(Math.min(...starts)).split(/["`\n]/)[0].trim()
}
