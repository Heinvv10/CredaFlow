/**
 * The shape every statement reader returns, whichever method read it.
 *
 * Amounts are signed integer cents: money in is positive, money out (fees
 * included) negative. Dates are calendar dates, `YYYY-MM-DD`, as printed.
 */

export type BankCode =
  | "CAPITEC"
  | "FNB"
  | "ABSA"
  | "NEDBANK"
  | "STANDARD_BANK"
  | "DISCOVERY"
  | "TYMEBANK"
  | "AFRICAN_BANK"
  | "INVESTEC"

export interface StatementTransaction {
  date: string
  description: string
  amountCents: number
  /** The running balance printed on the row, where the statement has one. */
  balanceCents: number | null
  /** 1-based page the row is printed on. */
  page: number
  /**
   * The bank prints the row but it moved no money (FNB's "EDO Collection
   * Attempt": a creditor's failed early debit order). Excluded from the
   * balance identity; the risk check still reads it.
   */
  nonPosting?: true
}

export interface StatementRead {
  accountHolderName: string | null
  accountNumberLast4: string | null
  periodStart: string | null
  periodEnd: string | null
  openingBalanceCents: number | null
  closingBalanceCents: number | null
  transactions: StatementTransaction[]
}

/** Facts about the file itself, independent of what it says. */
export interface AuthenticityFacts {
  producer: string | null
  creator: string | null
  /** ISO timestamps as pdfinfo reports them, or null when absent. */
  createdAt: string | null
  modifiedAt: string | null
  /** Revisions appended after the original save (0 for a file saved once). */
  incrementalUpdates: number
  /** Structural observations, e.g. TEXT_LAYER_ABSENT, NOT_A_PDF. */
  signals: string[]
}
