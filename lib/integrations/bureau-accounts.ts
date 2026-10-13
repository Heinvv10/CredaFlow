/**
 * One credit account as a bureau reports it, for the credit checks' debit-order
 * matching (lib/credit-checks/undisclosed-debt.ts). The bureau parsers return
 * the list beside their totals; lib/compliance/bureau-review.ts stores it as
 * CreditBureauCheck.obligations.accounts. Totals are unaffected by it.
 */
export interface BureauAccount {
  subscriber: string
  accountType: string | null
  /** Monthly instalment in cents. */
  instalmentCents: number
  status: string | null
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)

/** Rand amounts → BureauAccount[], dropping accounts with no subscriber name. */
export function bureauAccounts(
  rows: Array<Record<string, unknown>>,
  pick: (row: Record<string, unknown>) => { subscriber: unknown; accountType: unknown; instalmentRands: unknown; status: unknown },
): BureauAccount[] {
  return rows.flatMap((row) => {
    const p = pick(row)
    const subscriber = text(p.subscriber)
    if (!subscriber) return []
    const rands = typeof p.instalmentRands === "number" && Number.isFinite(p.instalmentRands) ? p.instalmentRands : 0
    return [{ subscriber, accountType: text(p.accountType), instalmentCents: Math.round(rands * 100), status: text(p.status) }]
  })
}
