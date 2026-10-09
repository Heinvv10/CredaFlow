import { sastCalendarDay } from "@/lib/loan/settlement"
import {
  MAX_UNREVIEWED_REBATE_CENTS,
  REBATE_ERASURE_FRACTION,
  VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS,
} from "@/lib/loan/value-date-limits"

/**
 * When money actually reached us, as distinct from when staff captured it.
 *
 * Interest must accrue to THIS date: NCA s125(2)(b) charges interest only up to
 * the settlement date, so capturing a week-old deposit at capture time bills the
 * client a week of credit they never had.
 *
 * Two bounds, and neither depends on who supplied the date:
 *   - impossible dates (future, before disbursement) are refused outright;
 *   - back-dating that writes off material interest needs a senior reasoned
 *     override, measured by the REBATE rather than the number of days.
 */
/**
 * Where the date came from. Retained for the AUDIT TRAIL only — it is no longer
 * a trust level, and no bound depends on it.
 *
 * It used to: bank-sourced dates skipped the recency window on the theory that a
 * third party had attested them. That theory was false. The ABSA statement is a
 * CSV a CREDIT_OFFICER uploads by hand, and `parseDate` accepts any date at all,
 * so a typed line was laundered into "bank-attested" — one rung BELOW the role
 * the staff override required, with no window, no reason, and an audit row that
 * affirmatively asserted third-party attestation. The bound below applies to
 * every source for that reason.
 */
export type ValueDateSource =
  | "BANK_STATEMENT"
  | "STAFF_ASSERTED"
  | "SYSTEM_OBSERVED"
  /**
   * The date was set when the receipt was created and this writer cannot tell
   * by whom — `Payment` has no source column. Used by reconciliation, which
   * re-prices a receipt someone else dated.
   *
   * Recorded as unknown rather than guessed: naming a source here would put a
   * false attestation in a compliance record, which is the same class of defect
   * as the BANK_ATTESTED bug described above, only inverted.
   */
  | "UNKNOWN_INHERITED"

/**
 * Back-dating is bounded by the RAND it writes off, not by days and not by a
 * fraction of interest. The constants live in `value-date-limits.ts` (a leaf,
 * so client components can label fields without importing the calculator);
 * the reasoning for the pair is here, with the rules that apply them.
 *
 * A day-based window cannot be right for every product: 14 days is a reasonable
 * capture lag, but on a 30-day loan it rebates 46.7% of the interest, and half
 * the catalogue is 30-day.
 *
 * A fraction is wrong in the other direction. Measured against real products, a
 * 9-day statement-import lag — entirely ordinary — is 30% of the interest on a
 * short-term loan while being R30.00 in actual money. A fraction cap refuses
 * that truthful import; an absolute cap does not, and still catches the cases
 * that matter: the same 14-day back-date is R116.67, and a 21-day lag on a
 * R500 000 facility is R8 750.00.
 *
 * But an absolute cap alone is not enough either: on a loan whose whole interest
 * is R100.00, a R100.00 cap permits writing off ALL of it. So a second clause
 * catches the shape of the attack rather than its size — back-dating that
 * erases essentially all the interest earned to date, which is what pricing a
 * loan at its disbursement day does.
 */
export {
  MAX_UNREVIEWED_REBATE_CENTS,
  REBATE_ERASURE_FRACTION,
  VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS,
} from "@/lib/loan/value-date-limits"

export type ValueDateRejection =
  | "future"
  | "before_loan_start"
  | "rebate_needs_authorisation"
  | "override_reason_too_short"

export const VALUE_DATE_MESSAGES: Record<ValueDateRejection, string> = {
  future: "Payment date cannot be in the future.",
  before_loan_start: "Payment date cannot be before the loan was disbursed.",
  rebate_needs_authorisation:
    "Back-dating this payment writes off more interest than may be approved unreviewed. A loan administrator must record a reason.",
  override_reason_too_short:
    `The reason must be at least ${VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS} characters.`,
}

export interface ValueDateOverride {
  reason: string
  approvedById: string
  approvedByEmail: string | null
}

/**
 * Bounds that hold for EVERY source and cannot be overridden — these are
 * physics, not policy. Checked before pricing, so an impossible date never
 * reaches the calculator.
 *
 * Compared by SAST CALENDAR DAY, never raw instants: the capture form sends a
 * date-only value that parses to UTC midnight, so a raw comparison would reject
 * a capture made between 00:00 and 02:00 SAST, and a repayment on the day the
 * loan was disbursed.
 */
const isDateOnly = (date: Date) =>
  date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0

export function rejectImpossibleValueDate(args: {
  receivedAt: Date
  asOf: Date
  loanStartDate: Date
}): ValueDateRejection | null {
  const day = sastCalendarDay(args.receivedAt)
  if (day > sastCalendarDay(args.asOf)) return "future"
  // Later today by instant is the future too: money cannot have arrived after
  // it was booked, and a receipt dated ahead of a Section 129 charge recorded
  // meanwhile would be re-split by it. A date-only value (UTC midnight, which
  // is 02:00 SAST) means "today" and stays accepted between 00:00 and 02:00.
  if (args.receivedAt > args.asOf && !isDateOnly(args.receivedAt)) return "future"
  // elapsedContractDays clamps at 0, so a pre-disbursement date prices the loan
  // at principal and fees and writes off every cent of earned interest. Note
  // `day === start` gives identical arithmetic and is legitimate on a loan
  // disbursed today — which is why the rebate bound below, not this one, is
  // what stops a months-old loan being settled at day-zero pricing.
  if (day < sastCalendarDay(args.loanStartDate)) return "before_loan_start"
  return null
}

/**
 * Bound on the interest a back-dated receipt writes off. Applied AFTER pricing,
 * because the rebate is only knowable once the receipt has been projected.
 *
 * Returns null when the rebate is small enough to stand unreviewed, or when a
 * sufficient reasoned override is present.
 */
export function rejectUnauthorisedRebate(args: {
  interestRebateCents: number
  /** Interest accrued as at capture time — what the rebate is measured against. */
  accruedInterestAtCaptureCents: number
  override?: ValueDateOverride | null
}): ValueDateRejection | null {
  const rebate = args.interestRebateCents
  if (rebate <= 0) return null

  const erasesInterest =
    args.accruedInterestAtCaptureCents > 0
    && rebate >= Math.floor(
      args.accruedInterestAtCaptureCents * REBATE_ERASURE_FRACTION,
    )
  if (rebate <= MAX_UNREVIEWED_REBATE_CENTS && !erasesInterest) return null

  if (!args.override) return "rebate_needs_authorisation"
  if (
    args.override.reason.trim().length
    < VALUE_DATE_OVERRIDE_MIN_REASON_CHARACTERS
  ) return "override_reason_too_short"
  return null
}

/**
 * The rebate bound for a receipt when default charges are live: contractual
 * interest and default charges erased by the date count together, AND erasing
 * essentially all the default charges is caught on its own, the same shape
 * rejectUnauthorisedRebate catches for contractual interest.
 */
export function rejectUnauthorisedBackdating(args: {
  interest: { rebateCents: number; accruedInterestAtCaptureCents: number }
  charges: { rebateCents: number; accruedAtCaptureCents: number }
  override?: ValueDateOverride | null
}): ValueDateRejection | null {
  return rejectUnauthorisedRebate({
    interestRebateCents: args.interest.rebateCents + args.charges.rebateCents,
    accruedInterestAtCaptureCents:
      args.interest.accruedInterestAtCaptureCents + args.charges.accruedAtCaptureCents,
    override: args.override,
  }) ?? rejectUnauthorisedRebate({
    interestRebateCents: args.charges.rebateCents,
    accruedInterestAtCaptureCents: args.charges.accruedAtCaptureCents,
    override: args.override,
  })
}

export interface ValueDateEvidence {
  receivedAt: string
  capturedAt: string
  source: ValueDateSource
  daysBackdated: number
  interestRebateCents: number
  /** the part of interestRebateCents that is default charges (charges-replay.ts) */
  defaultChargesRebateCents?: number
  override?: {
    reason: string
    approvedById: string
    approvedByEmail: string | null
  }
}

export function valueDateEvidence(args: {
  receivedAt: Date
  asOf: Date
  source: ValueDateSource
  interestRebateCents: number
  defaultChargesRebateCents?: number
  override?: ValueDateOverride | null
}): ValueDateEvidence {
  const daysBackdated =
    sastCalendarDay(args.asOf) - sastCalendarDay(args.receivedAt)
  return {
    receivedAt: args.receivedAt.toISOString(),
    capturedAt: args.asOf.toISOString(),
    source: args.source,
    daysBackdated,
    interestRebateCents: args.interestRebateCents,
    ...(args.defaultChargesRebateCents
      ? { defaultChargesRebateCents: args.defaultChargesRebateCents }
      : {}),
    ...(args.override
      ? {
          override: {
            reason: args.override.reason.trim(),
            approvedById: args.override.approvedById,
            approvedByEmail: args.override.approvedByEmail,
          },
        }
      : {}),
  }
}
