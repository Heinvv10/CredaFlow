import type { CandidateLoan, MatchResult, ParsedStatementLine } from "./types"

export const WEAK_DUE_WINDOW_DAYS = 5
const DAY_MS = 86_400_000

function digits(s: string | null): string {
  return (s ?? "").replace(/\D/g, "")
}

// Unambiguous pick: return the single matching candidate, or null if 0 or >1.
function only(cands: CandidateLoan[]): CandidateLoan | null {
  return cands.length === 1 ? cands[0] : null
}

// Match a loan reference as a bounded token — not a raw substring — so a
// payment for "LN-10" does not also match loan "LN-1" (sequential
// loan-number collision). Boundaries are non-alphanumeric chars or the ends
// of the string. Both args are already lowercased by the caller.
function refContainsToken(haystack: string, needle: string): boolean {
  if (needle.length < 3) return false
  const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(haystack)
}

export function matchTransactions(
  lines: ParsedStatementLine[],
  candidates: CandidateLoan[],
): MatchResult[] {
  return lines.map((line) => {
    if (line.direction !== "CREDIT") {
      return { line, tier: "NONE", confidence: null, matchedLoanId: null }
    }
    const ref = `${line.rawReference ?? ""} ${line.counterparty ?? ""}`.toLowerCase()
    const refDigits = digits(ref)

    const exact = only(
      candidates.filter((c) => refContainsToken(ref, c.loanReference.toLowerCase())),
    )
    if (exact) return { line, tier: "EXACT", confidence: "HIGH", matchedLoanId: exact.loanId }

    const amountMatch = candidates.filter((c) => c.expectedInstalmentCents === line.amountCents)

    const heuristic = only(
      amountMatch.filter(
        (c) =>
          c.clientNameTokens.some((t) => t.length >= 3 && ref.includes(t)) ||
          (c.clientPhoneDigits && c.clientPhoneDigits.length >= 6
            ? refDigits.includes(c.clientPhoneDigits)
            : false),
      ),
    )
    if (heuristic)
      return { line, tier: "HEURISTIC", confidence: "MEDIUM", matchedLoanId: heuristic.loanId }

    const weak = only(
      amountMatch.filter(
        (c) =>
          c.nextDueDate != null &&
          Math.abs(c.nextDueDate.getTime() - line.postedDate.getTime()) <=
            WEAK_DUE_WINDOW_DAYS * DAY_MS,
      ),
    )
    if (weak) return { line, tier: "WEAK", confidence: "LOW", matchedLoanId: weak.loanId }

    return { line, tier: "NONE", confidence: null, matchedLoanId: null }
  })
}
