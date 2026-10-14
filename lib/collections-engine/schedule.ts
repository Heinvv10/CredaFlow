/**
 * Builds collection instructions from a loan's instalment schedule. Pure: the
 * caller loads the rows and what has already been presented, and writes the
 * drafts. Dates are SAST calendar dates (YYYY-MM-DD).
 *
 * An instalment is never collected before it is due, never before the
 * mandate's first collection date, and never sooner than the provider's
 * submission lead allows. The amount is what is still outstanding on that
 * instalment, capped at the mandate maximum.
 */
import type { ScheduleStatus } from "@prisma/client"
import { addDays, dayInMonth } from "@/lib/credit-checks/dates"
import { addSouthAfricanBusinessDays, isSouthAfricanBusinessDate } from "@/lib/compliance/sa-business-days"
import {
  PLANNING_HORIZON_DAYS,
  SUBMISSION_LEAD_BUSINESS_DAYS,
  nextPresentmentNo,
  type PresentmentFact,
} from "./scheme-rules"

const shiftMonth = (month: string, by: number) => addDays(`${month}-15`, by * 30).slice(0, 7)

/** The debit day of a month (clamped to its last day), rolled forward to a business day. */
function rolledDebitDate(month: string, debitDay: number): string {
  let date = dayInMonth(month, debitDay)
  while (!isSouthAfricanBusinessDate(date)) date = addDays(date, 1)
  return date
}

/**
 * The first action date on or after `notBefore` for this debit day: each
 * month's debit day, clamped to month end and rolled forward to a business
 * day. Compared AFTER rolling, so the 25th that fell on a Sunday is still
 * Monday the 26th, and a month-end day that rolled into the next month counts.
 */
export function debitDateOnOrAfter(notBefore: string, debitDay: number): string {
  const month = notBefore.slice(0, 7)
  for (const by of [-1, 0, 1]) {
    const date = rolledDebitDate(shiftMonth(month, by), debitDay)
    if (date >= notBefore) return date
  }
  return rolledDebitDate(shiftMonth(month, 2), debitDay)
}

/** The earliest action date a batch submitted on `today` can carry. */
export function earliestActionDate(today: string): string {
  return addSouthAfricanBusinessDays(today, SUBMISSION_LEAD_BUSINESS_DAYS)
}

export interface PlanRow {
  id: string
  installmentNo: number
  /** SAST calendar date the instalment falls due. */
  dueOn: string
  totalDue: number
  totalPaid: number
  status: ScheduleStatus
  /** This instalment's instructions under the mandate being planned. */
  presentments: PresentmentFact[]
  /** SAST date of the latest result on this instalment, if any. */
  lastResolvedOn: string | null
}

export interface InstructionDraft {
  repaymentScheduleId: string
  installmentNo: number
  presentmentNo: number
  amountCents: number
  actionDate: string
}

const latest = (...dates: (string | null)[]) => dates.filter((d): d is string => d !== null).sort().at(-1)!

export function planInstructions(input: {
  mandate: { debitDay: number; maxAmountCents: number; firstCollectionDate: string }
  today: string
  rows: readonly PlanRow[]
}): InstructionDraft[] {
  const earliest = earliestActionDate(input.today)
  const horizon = addDays(input.today, PLANNING_HORIZON_DAYS)
  const drafts: InstructionDraft[] = []
  for (const row of [...input.rows].sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.installmentNo - b.installmentNo)) {
    if (row.status === "PAID" || row.status === "WRITTEN_OFF") continue
    const outstanding = row.totalDue - row.totalPaid
    if (outstanding <= 0) continue
    const presentmentNo = nextPresentmentNo(row.presentments)
    if (presentmentNo === null) continue
    const retryFrom = presentmentNo > 1 && row.lastResolvedOn ? addDays(row.lastResolvedOn, 1) : null
    const notBefore = latest(row.dueOn, earliest, input.mandate.firstCollectionDate, retryFrom)
    const actionDate = debitDateOnOrAfter(notBefore, input.mandate.debitDay)
    if (actionDate > horizon) continue
    drafts.push({
      repaymentScheduleId: row.id,
      installmentNo: row.installmentNo,
      presentmentNo,
      amountCents: Math.min(outstanding, input.mandate.maxAmountCents),
      actionDate,
    })
  }
  return drafts
}
