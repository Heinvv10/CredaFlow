/**
 * A WAIVER Payment is a non-cash credit that closes a sub-R1 residue
 * (lib/loan/small-balance-waiver.ts). It is ALLOCATED so every balance and
 * guard identity treats it like a receipt, but no money moved: it must never
 * count as cash collected, and it is shown as "Balance waived", not a method of
 * payment. Dependency-free so client components can import it.
 */

export const WAIVER_METHOD = "WAIVER"
export const BALANCE_WAIVED_LABEL = "Balance waived"
/** The old loan's balance moved into a new loan (lib/loan-changes): a receipt on every balance and guard, no money moved. */
export const LOAN_SETTLEMENT_METHOD = "LOAN_SETTLEMENT"
export const SETTLED_BY_NEW_LOAN_LABEL = "Settled by new loan"

/** Spread into any Payment where-clause that totals money actually received. */
export const CASH_RECEIPTS = { paymentMethod: { notIn: [WAIVER_METHOD, LOAN_SETTLEMENT_METHOD] as Array<"WAIVER" | "LOAN_SETTLEMENT"> } }

export function isBalanceWaiver(method: string | null | undefined): boolean {
  return method === WAIVER_METHOD
}

export function isNonCashReceipt(method: string | null | undefined): boolean {
  return isBalanceWaiver(method) || method === LOAN_SETTLEMENT_METHOD
}

/** The waiver or settlement label, or the surface's own formatting for a real method. */
export function displayPaymentMethod(method: string, format: (method: string) => string): string {
  if (method === LOAN_SETTLEMENT_METHOD) return SETTLED_BY_NEW_LOAN_LABEL
  return isBalanceWaiver(method) ? BALANCE_WAIVED_LABEL : format(method)
}

/**
 * Cash actually received on a loan: live ALLOCATED receipts, excluding
 * waivers, settlements by a new loan, reversals and unapplied or refunded money. This is "Total paid"
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
    || isNonCashReceipt(p.paymentMethod)
    || (p.allocationStatus !== undefined && p.allocationStatus !== "ALLOCATED")
      ? sum
      : sum + p.amount
  ), 0)
}

/** "You have paid N%": cash received over total repayable, one rule for every portal surface. */
export function cashPaidPercent(cashPaid: number, totalRepayable: number): number {
  return totalRepayable > 0 ? Math.min(Math.round((cashPaid / totalRepayable) * 100), 100) : 0
}
