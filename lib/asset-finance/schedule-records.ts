/**
 * The bridge between the solver's ScheduleRow and an asset-finance loan's
 * RepaymentSchedule rows. Pure: no database, no clock.
 *
 * STORED REPRESENTATION (booking writes it with toScheduleRecord; repricing
 * reads it back with ./stored-schedule.ts and rewrites the pending rows with
 * toScheduleRecord again):
 *   installmentNo = index + 1
 *   dueDate       = SAST midnight of the row's calendar due date
 *   payment       = the row's regular payment, round(B × weight) (+ a lump);
 *                   on the last row the solver's rounding residue included
 *   interestDue   = min(interest the period accrues, payment)
 *   principalDue  = payment − interestDue, plus the balloon on the last row
 *   feesDue = creditLifePremiumDue = 0;  totalDue = payment (+ the balloon)
 *
 * CAPITALISED INTEREST. A period whose payment is below the interest it
 * accrues (a skip period, weight 0, or a low seasonal weight) cannot pay that
 * interest. It stores interestDue = payment (0 on a skip row) and
 * principalDue = 0; the unpaid remainder, capitalisedInterestCents(row), is
 * added to the balance (the solver's negative principal), bears interest from
 * the next period on, and is repaid AS PRINCIPAL by later rows: their stored
 * principal exceeds the financed amount they amortise by exactly the interest
 * capitalised before them. So no stored amount is ever negative, and a receipt
 * allocated interest-first (s126 order, lib/loan/receipt-allocation.ts) only
 * ever pays interest a row actually charges as interest.
 *
 * Capitalised interest COMPOUNDS: once added to the balance, every later row
 * charges interest on it. That is allowed for a NON_NCA contract, the only
 * regime slice 1 books and reprices. It is a slice-2 issue for NCA asset
 * finance: NCA s103 (no interest on interest; the exact subsection is for the
 * lender's legal team to confirm) means an NCA skip or seasonal schedule must
 * not charge interest on capitalised interest, or must not capitalise it at
 * all. Nothing here enforces that.
 * // UNTESTED: NCA treatment of capitalised interest
 *
 * ZERO ROWS. A skip period is stored as a row with totalDue 0. Each consumer
 * tolerates it: receipt allocation fills nothing into it (owed 0);
 * recomputeLoanBalances never counts it as arrears (unpaid 0) and
 * nextPaymentDueDate skips it; apply-payment never rewrites it (its paid total
 * cannot change), so it stays PENDING; settlement allocates it 0; the statement
 * prints it as a R0.00 row. The debit mandate refuses it (lib/loan/
 * debit-mandate.ts: totalDue must be > 0), failing closed; an asset-finance
 * loan cannot carry a debit-order mandate anyway (the mandate route refuses an
 * entity borrower and needs consumer affordability evidence). Rows are kept
 * rather than omitted because repricing must know every period's due date, and
 * an omitted date cannot be recovered from the stored ones when they are all
 * clamped to a month end (anchor the 31st, payments only in 30-day months).
 *
 * INVARIANTS (F = financed amount, I = all interest the schedule accrues,
 * C = Σ capitalised interest >= 0; ./schedule-records.test.ts):
 *   every row:  principalDue >= 0, interestDue >= 0,
 *               interestDue <= totalDue − balloon   (never above the payment),
 *               totalDue = principalDue + interestDue
 *   schedule:   Σ principalDue = F + C   (balloon included)
 *               Σ interestDue  = I − C
 *               Σ totalDue     = F + I
 * LOAN TOTALS are these sums, so every reconciliation a consumer makes
 * (Σ principalDue = principal, Σ interestDue = totalInterest,
 * Σ totalDue = totalRepayable) holds:
 *   Loan.principal      = F + C   the capital the schedule repays
 *   Loan.totalInterest  = I − C   interest charged as interest
 *   Loan.totalRepayable = F + I
 * The cost of credit is therefore totalRepayable − F, not totalInterest; F is
 * the deal's financed amount (cash price − deposit − trade-in + fees).
 * recomputeLoanBalances' outstandingPrincipal is Σ unpaid principalDue: above
 * the true balance by the interest later rows will still capitalise (0 on a
 * schedule without skip or low-weight periods), and 0 only once every row is
 * paid. A repricing moves the three totals by the change in the pending rows
 * (./reprice-loan.ts), which keeps the identities.
 *
 * WEIGHTS ARE NOT STORED (RepaymentSchedule has no weight column and the
 * planned DealStructure does not exist yet): repricing derives them from the
 * payments, below and in ./stored-schedule.ts.
 */
import { SAST_OFFSET_MS } from "@/lib/date/sast"
import { toDayNumber } from "./dates"
import type { ScheduleRow } from "./types"

const MS_PER_DAY = 86_400_000
const WEIGHT_SCALE = 10_000 // weights snap to 4 decimals

export interface ScheduleRecordAmounts {
  installmentNo: number
  dueDate: Date
  principalDue: number
  interestDue: number
  feesDue: number
  creditLifePremiumDue: number
  totalDue: number
}

/** SAST midnight of a calendar date, the instant asset-finance due dates are stored at. */
export function dueDateInstant(iso: string): Date {
  return new Date(toDayNumber(iso, "dueDate") * MS_PER_DAY - SAST_OFFSET_MS)
}

/** The row's regular payment: what it pays besides the balloon. */
export const regularPaymentCents = (row: ScheduleRow): number => row.totalCents - row.balloonCents

/** Interest the row accrues but does not pay; it is added to the balance (header). */
export function capitalisedInterestCents(row: ScheduleRow): number {
  return Math.max(0, row.interestCents - regularPaymentCents(row))
}

export function toScheduleRecord(row: ScheduleRow): ScheduleRecordAmounts {
  const payment = regularPaymentCents(row)
  const interestDue = Math.min(row.interestCents, payment)
  return {
    installmentNo: row.index + 1,
    dueDate: dueDateInstant(row.dueDate),
    principalDue: payment - interestDue + row.balloonCents,
    interestDue,
    feesDue: row.feesCents,
    creditLifePremiumDue: 0,
    totalDue: row.totalCents,
  }
}

/** The most common positive value, the smallest on a tie; null when there is none. */
export function modalPositive(values: number[]): number | null {
  const counts = new Map<number, number>()
  for (const value of values) if (value > 0) counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: number | null = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && value < best)) {
      best = value
      bestCount = count
    }
  }
  return best
}

/**
 * Weights for `regulars` (one regular payment per pending row, the final row
 * last) against reference instalment R = `referenceCents`:
 *   weight_i = regular_i / R
 * R is the base instalment the rows were solved with: the latest
 * ContractRate.newInstalmentCents, which booking and every repricing record.
 * round(B × w) loses up to half a cent, so a weight is snapped to 4 decimals
 * when the snapped value reproduces the stored payment: exactly
 * (round(R × w) = regular) on a regular row, and within `finalToleranceCents`
 * on the final row, which also carries the solver's rounding residue. With the
 * recorded B every 4-decimal weight snaps and the re-solve is exact
 * (./reprice.test.ts). A skip row's payment is 0, so its weight is 0.
 *
 * Without a recorded B (a row written before booking recorded it), R is the
 * most common positive regular payment of the pending non-final rows; the
 * solve is invariant to scaling every weight by one constant, so that scale
 * is harmless, but R is itself rounded: a weight w then carries an error of up
 * to half a cent × w / w_R, where w_R is R's own weight, and does not snap.
 * The re-solved payments match the pattern only to within about that many
 * cents per row (a seasonal 3 / 0.2 pattern: up to 8), the last row absorbing
 * the sum; the balance still lands exactly on the balloon.
 */
export function deriveWeights(regulars: number[], referenceCents: number, finalToleranceCents: number): number[] {
  if (!Number.isSafeInteger(referenceCents) || referenceCents <= 0) {
    throw new RangeError("referenceCents: must be a positive integer number of cents")
  }
  const last = regulars.length - 1
  return regulars.map((regular, i) => {
    const raw = regular / referenceCents
    const snapped = Math.round(raw * WEIGHT_SCALE) / WEIGHT_SCALE
    const reproduces = i === last
      ? Math.abs(referenceCents * snapped - regular) <= finalToleranceCents
      : Math.round(referenceCents * snapped) === regular
    return reproduces ? snapped : raw
  })
}
