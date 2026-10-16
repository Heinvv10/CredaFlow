import { sastCalendarDay } from "@/lib/loan/settlement"

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
// Per schedule row, the amount EARNED by the settlement date:
//   a row due on or before the settlement date   its full totalDue
//                                                (principal, interest, fees,
//                                                premium — all fell due);
//   the row whose period contains the date       its principal, plus its
//                                                interest pro rata to the SAST
//                                                days elapsed in the period;
//   every later row                              its principal only.
// A deferred initiation fee (folded into instalment 1, lib/loan-calculator.ts)
// was charged at origination, not earned over time: it stays payable whatever
// the date. The service fee and credit-life premium of a row not yet due are
// not charged (they fall due with their instalment).
//
// Settlement = Σ earned − total paid. Money a consumer prepaid on future rows
// is credited, because Σ earned counts only what is owed.
//
// ⚠️ LEGAL CONFIRMATION GATE: the two calls above (no current-month service
// fee or premium; pro-rata current-period interest) are this module's
// consumer-protective reading of "payable up to the settlement date".

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
  /** the initiation fee at booking; only the part folded into row 1 matters here */
  initiationFee: number
  /** the agreed monthly service fee (Loan.monthlyServiceFee); null on legacy rows */
  monthlyServiceFee?: number | null
}

export interface S125Settlement {
  /** what settles the agreement on the settlement date, before default charges */
  settlementDue: number
  /** interest of the current period, pro rata */
  accruedInterest: number
  /** contractual remaining − settlementDue: unearned interest, fees and premiums not charged */
  rebate: number
}

/** The deferred initiation fee carried in instalment 1: its fees above the regular service fee. */
function deferredInitiationFee(loan: S125Loan, rows: S125Row[]): number {
  if (rows.length < 2 || loan.initiationFee <= 0) return 0
  const regularFee = loan.monthlyServiceFee ?? rows[1].feesDue
  return Math.min(loan.initiationFee, Math.max(0, rows[0].feesDue - regularFee))
}

/**
 * The s125 settlement of a multi-instalment agreement on `asOf`. `rows` in
 * instalment order. Pure; amounts in cents.
 */
export function s125InstalmentSettlement(loan: S125Loan, rows: S125Row[], asOf: Date): S125Settlement {
  const today = sastCalendarDay(asOf)
  const initiation = deferredInitiationFee(loan, rows)
  let earned = 0
  let accruedInterest = 0
  let currentFound = false
  let periodStart = sastCalendarDay(loan.startDate)
  for (const [index, row] of rows.entries()) {
    const due = sastCalendarDay(row.dueDate)
    if (due <= today) {
      earned += row.totalDue
    } else if (!currentFound) {
      currentFound = true
      const period = Math.max(1, due - periodStart)
      const elapsed = Math.min(period, Math.max(0, today - periodStart))
      accruedInterest = Math.round((row.interestDue * elapsed) / period)
      earned += row.principalDue + accruedInterest + (index === 0 ? initiation : 0)
    } else {
      earned += row.principalDue + (index === 0 ? initiation : 0)
    }
    periodStart = due
  }
  const contractualRemaining = Math.max(0, rows.reduce((sum, row) => sum + row.totalDue, 0) - loan.totalPaid)
  const settlementDue = Math.max(0, earned - loan.totalPaid)
  return {
    settlementDue,
    accruedInterest,
    rebate: contractualRemaining - settlementDue,
  }
}
