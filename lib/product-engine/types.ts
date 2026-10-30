/**
 * The repayment structure of a product (docs/product-engine/DESIGN.md). All money is integer cents.
 *
 * A structure is `frequency` x `structure` x `grace`, over `instalments` periods in total (grace periods included):
 *
 *   structure AMORTISING     equal instalments: principal and interest together clear the balance by the last one
 *   structure INTEREST_ONLY  interest every period, the whole principal with the last instalment
 *   structure BULLET         one payment at the end: principal and all the interest
 *
 *   grace PRINCIPAL_ONLY     the first `graceInstalments` instalments pay interest only; principal starts after them
 *   grace FULL               nothing is due for the first `graceInstalments` periods (no schedule rows); the interest
 *                            that accrues meanwhile is deferred and spread, as simple interest (never interest on
 *                            interest), over the instalments that follow
 */
export const FREQUENCIES = ["WEEKLY", "FORTNIGHTLY", "MONTHLY"] as const
export type Frequency = (typeof FREQUENCIES)[number]

export const STRUCTURES = ["AMORTISING", "INTEREST_ONLY", "BULLET"] as const
export type RepaymentStructure = (typeof STRUCTURES)[number]

export const GRACE_KINDS = ["NONE", "PRINCIPAL_ONLY", "FULL"] as const
export type GraceKind = (typeof GRACE_KINDS)[number]

/** The interest bases the engine computes; DAILY_ACCRUAL stays with the single-payment products of lib/loan-calculator.ts. */
export type EngineInterestModel = "FLAT" | "REDUCING_BALANCE"

export interface RepaymentTerms {
  frequency: Frequency
  structure: RepaymentStructure
  graceKind: GraceKind
  /** Instalments (periods) of grace; 0 with graceKind NONE. */
  graceInstalments: number
  /** Periods in the whole term, grace included. */
  instalments: number
}

export interface ScheduleRowOut {
  installmentNo: number
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  totalDue: number
  openingBalance: number
  closingBalance: number
}

export interface GeneratedSchedule {
  schedule: ScheduleRowOut[]
  totalInterest: number
  serviceFees: number
}

/** Days a period stands for when a term in days is turned into instalments (the month is 30 days, as everywhere in billing). */
export const PERIOD_DAYS: Record<Frequency, number> = { WEEKLY: 7, FORTNIGHTLY: 14, MONTHLY: 30 }

/** Periods in a year, which turns the monthly rate into the rate of one period. */
export const PERIODS_PER_YEAR: Record<Frequency, number> = { WEEKLY: 52, FORTNIGHTLY: 26, MONTHLY: 12 }
