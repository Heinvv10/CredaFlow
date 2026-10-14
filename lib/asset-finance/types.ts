// Shared shapes for the asset-finance structure solver. All money is integer
// cents; rates are decimals (0.1175 = 11.75% nominal per annum); dates are
// ISO calendar dates "YYYY-MM-DD" with no time and no zone.

export interface RatePoint {
  effectiveDate: string // YYYY-MM-DD, the first day the rate applies
  annualRate: number // 0.1175 = 11.75% nominal p.a.
}

export interface VatDeferral {
  vatCents: number
  periodIndex: number // 0-based period whose payment carries the VAT lump
}

export interface StructureInput {
  cashPriceCents: number // incl. VAT, the amount the supplier is paid
  depositCents: number
  tradeInCents: number
  financedFeesCents: number // fees added to the financed amount
  balloonCents: number // residual paid with (on top of) the last instalment
  vatDeferralPeriods?: VatDeferral
  weights: number[] // one per period, >= 0; 0 = skip, 1 = normal, n = seasonal multiple
  startDate: string // contract start; interest accrues from the day after
  firstDueDate?: string // default: startDate + 1 month (clamped to month end)
  ratePath: RatePoint[] // sorted; first effectiveDate <= startDate
}

export interface ScheduleRow {
  index: number
  dueDate: string
  weight: number
  openingBalanceCents: number
  interestCents: number
  principalCents: number
  feesCents: number
  balloonCents: number
  totalCents: number
  closingBalanceCents: number
}

export interface StructureResult {
  financedAmountCents: number
  baseInstalmentCents: number
  rows: ScheduleRow[]
  totalInterestCents: number
  totalPayableCents: number
}
