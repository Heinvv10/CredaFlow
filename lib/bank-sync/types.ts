export type BankTxnDirection = "CREDIT" | "DEBIT"
export type MatchTier = "EXACT" | "HEURISTIC" | "WEAK" | "NONE"
export type MatchConfidence = "HIGH" | "MEDIUM" | "LOW"

export interface ParsedStatementLine {
  postedDate: Date
  valueDate: Date | null
  amountCents: number // signed; credit positive
  direction: BankTxnDirection
  rawReference: string | null
  counterparty: string | null
  balanceCents: number | null
  bankTxnId: string | null
}

export interface CandidateLoan {
  loanId: string
  loanReference: string // Loan.reference, e.g. "LN-0099"
  expectedInstalmentCents: number
  clientNameTokens: string[] // lowercased
  clientPhoneDigits: string | null // digits only
  nextDueDate: Date | null
}

export interface MatchResult {
  line: ParsedStatementLine
  tier: MatchTier
  confidence: MatchConfidence | null
  matchedLoanId: string | null
}
