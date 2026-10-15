/**
 * Where a bank prints no opening balance (ABSA Transaction History,
 * Discovery), the reader derives it from the first row, so nothing checks
 * that row's amount; with no closing (Discovery), nothing checks the last.
 * The account's adjacent statement does: when one opens to the cent where the
 * previous one closed, an edit to either boundary row breaks that equality,
 * as it would break a printed opening. A boundary that does not chain stays
 * with a person (manual-review.ts).
 */
import { STATEMENT_CHAIN_MAX_GAP_DAYS } from "./policy"
import type { StatementFacts } from "./types"

/** A read whose arithmetic is evidence: the bank's own text, reconciled. A vision read never is. */
const reconciled = (s: StatementFacts) => s.state === "READ" && s.method === "TEXT" && s.balanceCheck === "PASS" && !!s.read

const day = (iso: string) => Date.parse(iso) / 86_400_000

/** `next` is the statement after `prev` on the same account, and opens where `prev` closed. */
function follows(prev: StatementFacts, next: StatementFacts): boolean {
  if (prev.documentId === next.documentId || !reconciled(prev) || !reconciled(next) || !prev.bank || prev.bank !== next.bank) return false
  const a = prev.read!
  const b = next.read!
  if (!a.accountNumberLast4 || a.accountNumberLast4 !== b.accountNumberLast4 || !a.periodEnd || !b.periodStart) return false
  const gap = day(b.periodStart) - day(a.periodEnd)
  return gap >= 0 && gap <= STATEMENT_CHAIN_MAX_GAP_DAYS && a.closingBalanceCents !== null && a.closingBalanceCents === b.openingBalanceCents
}

/** The previous statement of the account closes where `s` opens: its first row is checked. */
export function firstRowChained(s: StatementFacts, all: StatementFacts[]): boolean {
  return all.some((prev) => follows(prev, s))
}

/** The next statement of the account opens where `s` closes: its last row is checked. */
export function lastRowChained(s: StatementFacts, all: StatementFacts[]): boolean {
  return all.some((next) => follows(s, next))
}
