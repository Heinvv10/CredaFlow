/**
 * A WAIVER Payment is a non-cash credit that closes a sub-R1 residue
 * (lib/loan/small-balance-waiver.ts). It is ALLOCATED so every balance and
 * guard identity treats it like a receipt, but no money moved: it must never
 * count as cash collected, and it is shown as "Balance waived", not a method of
 * payment. Dependency-free so client components can import it.
 */

export const WAIVER_METHOD = "WAIVER"
export const BALANCE_WAIVED_LABEL = "Balance waived"

/** Spread into any Payment where-clause that totals money actually received. */
export const CASH_RECEIPTS = { paymentMethod: { not: WAIVER_METHOD } } as const

export function isBalanceWaiver(method: string | null | undefined): boolean {
  return method === WAIVER_METHOD
}

/** The waiver label, or the surface's own formatting for a real method. */
export function displayPaymentMethod(method: string, format: (method: string) => string): string {
  return isBalanceWaiver(method) ? BALANCE_WAIVED_LABEL : format(method)
}

/**
 * Cash actually received on a loan: live ALLOCATED receipts, excluding
 * waivers, reversals and unapplied or refunded money. This is "Total paid"
 * wherever it is shown; Loan.totalPaid is only the share applied to the
 * instalments once default charges exist.
 */
export function cashReceivedCents(payments: Array<{
  amount: number
  paymentMethod?: string
  reversed?: boolean
  allocationStatus?: string
}>): number {
  return payments.reduce((sum, p) => (
    p.reversed
    || isBalanceWaiver(p.paymentMethod)
    || (p.allocationStatus !== undefined && p.allocationStatus !== "ALLOCATED")
      ? sum
      : sum + p.amount
  ), 0)
}

/** "You have paid N%": cash received over total repayable, one rule for every portal surface. */
export function cashPaidPercent(cashPaid: number, totalRepayable: number): number {
  return totalRepayable > 0 ? Math.min(Math.round((cashPaid / totalRepayable) * 100), 100) : 0
}
