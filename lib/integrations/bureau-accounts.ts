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

/** The subscriber of an account the bureau reports without a name. */
export const UNKNOWN_SUBSCRIBER = "UNKNOWN"

/** One account as affordability needs it: every account the bureau reports. */
export interface BureauObligationRow {
  subscriber: string
  accountType: string | null
  /** Monthly instalment in cents; null when the bureau sent an amount that cannot be read. */
  instalmentCents: number | null
  status: string | null
}

/**
 * A bureau amount in rands, as cents. A finite number or a plain decimal
 * string ("5000.00") is read; an absent amount is zero; anything else present
 * ("R5,000", "n/a", NaN) is null — unknown, never silently zero.
 */
export function randAmountCents(value: unknown): number | null {
  if (value === undefined || value === null) return 0
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : null
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Math.round(Number(value) * 100)
  return null
}

/**
 * Rand amounts → BureauObligationRow[], keeping EVERY account: a nameless one
 * as UNKNOWN_SUBSCRIBER, an unreadable amount as null. This is the debt list
 * (lib/bureau); bureauAccounts above is the credit checks' named list.
 */
export function bureauObligationRows(
  rows: Array<Record<string, unknown>>,
  pick: (row: Record<string, unknown>) => { subscriber: unknown; accountType: unknown; instalmentRands: unknown; status: unknown },
): BureauObligationRow[] {
  return rows.map((row) => {
    const p = pick(row)
    return {
      subscriber: text(p.subscriber) ?? UNKNOWN_SUBSCRIBER,
      accountType: text(p.accountType),
      instalmentCents: randAmountCents(p.instalmentRands),
      status: text(p.status),
    }
  })
}
