/**
 * The go-live cutover. The first month a lender closes is its go-live month
 * (AccountingSettings.goLiveMonth). Everything before that month is not
 * replayed as journals: each source's position at the start of the month is
 * stored (AccountingOpeningPosition, so later months post only what changes
 * after go-live) and posted as ONE opening entry. Balance-sheet roles carry
 * (loan book, unallocated receipts, credit-life payable, payout clearing,
 * output VAT); bank and income/expense history nets into
 * OPENING_BALANCE_EQUITY, which the accountant reconciles to the legacy ledger.
 */
import { NOT_CARRIED_AT_OPENING, type AccountMap, type AccountRole } from "./accounts"
import { desiredSources, linesOf, type DerivedEntry, type PostedLedger } from "./derive"
import type { AccountingPeriod } from "./period"
import type { SourceLoan, Vector } from "./sources"

export interface OpeningPosition {
  baseKey: string
  loanId: string | null
  reference: string
  role: AccountRole
  cents: number
}

export const OPENING_BASE_KEY = "opening"

export function openingPositions(loans: SourceLoan[], period: AccountingPeriod): OpeningPosition[] {
  const out: OpeningPosition[] = []
  for (const source of desiredSources(loans, period.start)) {
    for (const [role, cents] of Object.entries(source.vector)) {
      if (cents) out.push({ baseKey: source.baseKey, loanId: source.loanId, reference: source.reference, role: role as AccountRole, cents })
    }
  }
  return out
}

/** The single opening entry, or null when nothing preceded go-live. */
export function openingEntry(positions: OpeningPosition[], period: AccountingPeriod, accounts: AccountMap): DerivedEntry | null {
  const vector: Vector = {}
  for (const p of positions) {
    const role: AccountRole = NOT_CARRIED_AT_OPENING.includes(p.role) ? "OPENING_BALANCE_EQUITY" : p.role
    vector[role] = (vector[role] ?? 0) + p.cents
  }
  const lines = linesOf(vector, accounts)
  if (lines.length === 0) return null
  return {
    eventKey: `${OPENING_BASE_KEY}:${period.key}`,
    baseKey: OPENING_BASE_KEY,
    eventType: "OPENING",
    eventDate: period.start,
    postingDate: period.firstDay,
    loanId: null,
    reference: "OPENING",
    description: `Opening position at go-live (${period.label}): balances carried from before CredaFlow's export`,
    lines,
  }
}

/** Opening positions as a posted ledger, the starting point for the go-live month's own entries. */
export function positionsAsLedger(positions: OpeningPosition[]) {
  const posted: PostedLedger = new Map()
  const postedKeys = new Set<string>()
  const postedLoans = new Map<string, { loanId: string | null; reference: string }>()
  for (const p of positions) {
    const vector = posted.get(p.baseKey) ?? {}
    vector[p.role] = (vector[p.role] ?? 0) + p.cents
    posted.set(p.baseKey, vector)
    postedKeys.add(p.baseKey)
    postedLoans.set(p.baseKey, { loanId: p.loanId, reference: p.reference })
  }
  return { posted, postedKeys, postedLoans }
}
