/**
 * The source-neutral facts the outcome functions read. A source adapter
 * (./credaflow-adapter.ts, ./external-extract-adapter.ts) maps its rows into
 * this shape; nothing here names a table or a lender. Days are SAST
 * `yyyy-mm-dd`; amounts are cents.
 */

export interface InstalmentFact {
  /** Opaque: a schedule row id or an extract row key. */
  ref: string
  installmentNo: number
  dueDay: string
  totalDueCents: number
  paidInFull: boolean
  /** The day the payment that completed it arrived; null if unpaid or unknown. */
  paidDay: string | null
}

export interface ArrearsDayFact {
  day: string
  daysInArrears: number
  /** The loan's status that day was DEFAULTED. */
  defaulted: boolean
}

export interface ReturnedDebitOrderFact {
  /** Opaque: a CollectionResult id or an extract row key. */
  ref: string
  installmentNo: number
  amountCents: number
  /** The provider's normalised reason, kept as is (never collapsed); null when it gave none. */
  reasonCode: string | null
  resolvedAt: Date
}

export type LoanEnd =
  | { kind: "OPEN" }
  /** COMPLETED, WRITTEN_OFF or CANCELLED on `day`; null when the close date is unknown. */
  | { kind: "SETTLED" | "WRITTEN_OFF" | "CANCELLED"; day: string | null }

export interface LoanFacts {
  /** Opaque: the loan id or an extract row key. */
  ref: string
  maturityDay: string
  end: LoanEnd
  /** Due-date order. */
  instalments: InstalmentFact[]
  /** One entry per day the loan's position was recorded; a missing day is a gap. */
  arrearsHistory: ArrearsDayFact[]
  returns: ReturnedDebitOrderFact[]
}
