/**
 * Where a bank prints no opening balance (ABSA Transaction History,
 * Discovery), the reader derives it from the first row, so nothing checks
 * that row's amount; with no closing (Discovery), nothing checks the last.
 *
 * The account's adjacent statement can agree with that boundary: one opens to
 * the cent where the previous one closed. The client uploads both, so
 * agreement is not independent evidence (a fabricated previous statement can
 * be made to close on a forged opening): the boundary flag is raised all the
 * same, and the neighbour goes on its evidence for the officer to compare.
 */
import { addDays } from "./dates"
import { documentAuthenticity } from "./document-authenticity"
import { STATEMENT_CHAIN_MAX_GAP_DAYS } from "./policy"
import type { ApplicationFacts, StatementFacts } from "./types"

/** A read whose arithmetic says something: the bank's own text, reconciled, over a period that runs forwards. */
function reconciled(s: StatementFacts): boolean {
  const r = s.read
  return s.state === "READ" && s.method === "TEXT" && s.balanceCheck === "PASS" && !!s.contentSha256
    && !!r?.periodStart && !!r.periodEnd && r.periodStart <= r.periodEnd
}

const holder = (name: string | null) => (name ?? "").normalize("NFKC").toUpperCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()

/**
 * The neighbour must raise no DOCUMENT_AUTHENTICITY finding about its file. A
 * stale one still counts: the previous month of a three-month window ends
 * more than STALE_STATEMENT_DAYS before most applications.
 */
function clean(n: StatementFacts, f: ApplicationFacts): boolean {
  return documentAuthenticity({ ...f, statements: [n] }).every((c) => c.code === "STALE_STATEMENT")
}

/** `next` is the statement after `prev` on the same account, and opens where `prev` closed. */
function follows(prev: StatementFacts, next: StatementFacts): boolean {
  if (!reconciled(prev) || !reconciled(next) || prev.contentSha256 === next.contentSha256 || !prev.bank || prev.bank !== next.bank) return false
  const a = prev.read!
  const b = next.read!
  if (!a.accountNumberLast4 || a.accountNumberLast4 !== b.accountNumberLast4) return false
  if (!holder(a.accountHolderName) || holder(a.accountHolderName) !== holder(b.accountHolderName)) return false
  const adjacent = Array.from({ length: STATEMENT_CHAIN_MAX_GAP_DAYS + 1 }, (_, d) => addDays(a.periodEnd!, d)).includes(b.periodStart!)
  return a.periodStart! < b.periodStart! && adjacent && a.closingBalanceCents !== null && a.closingBalanceCents === b.openingBalanceCents
}

/** The neighbour as it goes on a boundary flag's evidence (`chainedWith`). */
const cite = (n: StatementFacts) => ({ documentId: n.documentId, periodStart: n.read!.periodStart, periodEnd: n.read!.periodEnd })

/** The previous statement of the account, closing where `s` opens, if one was uploaded. */
export function previousStatement(s: StatementFacts, f: ApplicationFacts) {
  const prev = f.statements.find((p) => p.documentId !== s.documentId && follows(p, s) && clean(p, f))
  return prev ? { ...cite(prev), closingCents: prev.read!.closingBalanceCents } : null
}

/** The next statement of the account, opening where `s` closes, if one was uploaded. */
export function nextStatement(s: StatementFacts, f: ApplicationFacts) {
  const next = f.statements.find((n) => n.documentId !== s.documentId && follows(s, n) && clean(n, f))
  return next ? { ...cite(next), openingCents: next.read!.openingBalanceCents } : null
}
