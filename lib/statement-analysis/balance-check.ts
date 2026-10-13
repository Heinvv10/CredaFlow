import type { StatementRead } from "./types"

/** Rounding the bank itself may show between a total and its parts. */
export const BALANCE_TOLERANCE_CENTS = 1

export interface BalanceCheckResult {
  result: "PASS" | "FAIL" | "NOT_APPLICABLE"
  /** (opening + Σ amounts) − closing; null when not applicable. */
  diffCents: number | null
  /** Indexes of rows whose printed balance ≠ previous balance + amount. */
  breaks: number[]
}

/**
 * The arithmetic identity every statement must satisfy: opening + Σ amounts =
 * closing, and, where a running balance is printed, each row's balance =
 * the previous balance + its amount.
 *
 * It is the oracle for reading accuracy (a misread figure breaks it) and, on a
 * digital PDF, the strongest tamper signal (an edited figure breaks it unless
 * the forger re-derived every later balance).
 */
export function checkBalance(read: StatementRead): BalanceCheckResult {
  const { openingBalanceCents: opening, closingBalanceCents: closing, transactions } = read
  if (opening === null || closing === null) {
    return { result: "NOT_APPLICABLE", diffCents: null, breaks: [] }
  }
  const breaks: number[] = []
  let running = opening
  transactions.forEach((t, i) => {
    if (t.nonPosting) return
    running += t.amountCents
    if (t.balanceCents === null) return
    if (Math.abs(running - t.balanceCents) > BALANCE_TOLERANCE_CENTS) breaks.push(i)
    // Continue from the printed balance so one break is reported once, not
    // carried into every row after it.
    running = t.balanceCents
  })
  const total = opening + transactions.reduce((sum, t) => sum + (t.nonPosting ? 0 : t.amountCents), 0)
  const diffCents = total - closing
  const ok = Math.abs(diffCents) <= BALANCE_TOLERANCE_CENTS && breaks.length === 0
  return { result: ok ? "PASS" : "FAIL", diffCents, breaks }
}
