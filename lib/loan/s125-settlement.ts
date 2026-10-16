import { sastCalendarDate } from "@/lib/date/sast"

/** Days since 1970-01-01 of the SAST calendar day (as lib/loan/settlement.ts sastCalendarDay). */
const sastDay = (date: Date) => Date.parse(sastCalendarDate(date)) / 86_400_000

// NCA s125: the settlement amount of an instalment agreement.
//
// s125(2): the amount required to settle is the unpaid balance of the
// principal debt at that time, plus the unpaid interest charges and all other
// fees and charges payable by the consumer to the credit provider up to the
// settlement date. Interest the agreement would have charged for the months
// after the settlement date is NOT payable. s125(3) (an early-termination
// charge of up to three months' interest) applies to large agreements only,
// and no CredaFlow consumer product is a large agreement, so none is added.
//
// Each schedule row is re-priced to what it EARNED by the settlement date:
//   a row due on or before the settlement date   unchanged (everything in it
//                                                fell due);
//   the row whose period contains the date       its principal, plus its
//                                                interest pro rata to the SAST
//                                                days elapsed in the period;
//   every later row                              its principal only.
// A deferred initiation fee (folded into instalment 1, lib/loan-calculator.ts)
// was charged at origination, not earned over time: it stays payable whatever
// the date. The service fee and credit-life premium of a row not yet due are
// not charged (they fall due with their instalment). `feesDue` includes the
// row's premium (lib/compliance/pasq.ts); both are re-priced together.
//
// Settlement = Σ re-priced totalDue − total paid: money prepaid on future rows
// is credited, because the re-priced rows count only what is owed.
//
// ⚠️ LEGAL CONFIRMATION GATE: (a) no service fee or premium for the current,
// not-yet-due instalment; (b) current-period interest pro rata by day. Both are
// this module's consumer-protective reading of "payable up to the settlement
// date"; the PR records them for sign-off.

export interface S125Row {
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  creditLifePremiumDue?: number
  totalDue: number
}

export interface S125Loan {
  startDate: Date
  totalPaid: number
  /** the initiation fee at booking, bounding the part folded into row 1; absent: read from row 1 */
  initiationFee?: number
  /** the agreed monthly service fee (Loan.monthlyServiceFee); null on legacy rows */
  monthlyServiceFee?: number | null
}

export interface S125RowPrice {
  interestDue: number
  feesDue: number
  /** unchanged (as given) on a row already due; 0 on a re-priced one */
  creditLifePremiumDue?: number
  totalDue: number
}

export interface S125Settlement {
  /** each row as the settlement prices it, in the order given */
  rows: S125RowPrice[]
  /** what settles the agreement on the settlement date, before default charges */
  settlementDue: number
  /** interest of the current period, pro rata */
  accruedInterest: number
  totalInterest: number
  totalRepayable: number
  /** contractual remaining − settlementDue: unearned interest, fees and premiums */
  rebate: number
}

const premiumOf = (row: S125Row) => row.creditLifePremiumDue ?? 0

/** The deferred initiation fee carried in instalment 1: its fees above the regular service fee and premium. */
function deferredInitiationFee(loan: S125Loan, rows: S125Row[]): number {
  if (rows.length < 2 || loan.initiationFee === 0) return 0
  const regularFee = loan.monthlyServiceFee ?? rows[1].feesDue - premiumOf(rows[1])
  const folded = Math.max(0, rows[0].feesDue - premiumOf(rows[0]) - regularFee)
  return loan.initiationFee === undefined ? folded : Math.min(loan.initiationFee, folded)
}

/**
 * The s125 settlement of a multi-instalment agreement on `asOf`. `rows` in
 * instalment (due-date) order. Pure; amounts in cents.
 */
export function s125InstalmentSettlement(loan: S125Loan, rows: S125Row[], asOf: Date): S125Settlement {
  const today = sastDay(asOf)
  const initiation = deferredInitiationFee(loan, rows)
  let currentFound = false
  let accruedInterest = 0
  let periodStart = sastDay(loan.startDate)
  const priced = rows.map((row, index): S125RowPrice => {
    const due = sastDay(row.dueDate)
    const start = periodStart
    periodStart = due
    if (due <= today) {
      return { interestDue: row.interestDue, feesDue: row.feesDue, creditLifePremiumDue: row.creditLifePremiumDue, totalDue: row.totalDue }
    }
    let interestDue = 0
    if (!currentFound) {
      currentFound = true
      const period = Math.max(1, due - start)
      const elapsed = Math.min(period, Math.max(0, today - start))
      interestDue = Math.round((row.interestDue * elapsed) / period)
      accruedInterest = interestDue
    }
    const feesDue = index === 0 ? initiation : 0
    return { interestDue, feesDue, creditLifePremiumDue: 0, totalDue: row.principalDue + interestDue + feesDue }
  })
  const totalRepayable = priced.reduce((sum, row) => sum + row.totalDue, 0)
  const contractual = rows.reduce((sum, row) => sum + row.totalDue, 0)
  const settlementDue = Math.max(0, totalRepayable - loan.totalPaid)
  return {
    rows: priced,
    settlementDue,
    accruedInterest,
    totalInterest: priced.reduce((sum, row) => sum + row.interestDue, 0),
    totalRepayable,
    rebate: Math.max(0, contractual - loan.totalPaid) - settlementDue,
  }
}
