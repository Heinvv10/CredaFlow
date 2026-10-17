import type { ChargesReplay } from "@/lib/loan/charges-replay"
import type { DefaultChargeInput } from "@/lib/loan/default-charges"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, toDayNumber } from "./dates"
import { dueDateInstant } from "./schedule-records"
import { rateDaySum, rateSegments } from "./rates"
import type { RatePoint } from "./types"

type Row = DefaultChargeInput["schedule"][number] & { commonLawContractualInterestDue?: number | null }
/** Compare legally earned amounts, including the common-law combined ceiling.
 * Keep signed principal allocations as the cap's capital basis; a reduction
 * of interest never invents a principal receipt. Future unearned periods are
 * removed at the statement/settlement date before the chronological replay.
 */
export function lawfulRateCorrection(replay: ChargesReplay, rows: Row[], startDate: string, oldPath: RatePoint[], newPath: RatePoint[], asOf: Date): number {
  const start = toDayNumber(startDate)
  const end = toDayNumber(sastCalendarDate(asOf))
  const oldSegments = rateSegments(oldPath, start)
  const candidate = (path: RatePoint[]) => {
    const segments = rateSegments(path, start)
    return rows.map((row, index) => {
      const from = index === 0 ? start : toDayNumber(sastCalendarDate(rows[index - 1].dueDate))
      const due = toDayNumber(sastCalendarDate(row.dueDate))
      const through = Math.min(end, due)
      const oldDays = rateDaySum(oldSegments, from, due)
      const full = row.commonLawContractualInterestDue ?? row.interestDue
      const interest = through <= from ? 0 : oldDays === 0 ? full : Math.round(full * rateDaySum(segments, from, through) / oldDays)
      return { ...row, dueDate: through < due ? dueDateInstant(sastCalendarDate(asOf)) : row.dueDate, interestDue: interest, commonLawContractualInterestDue: interest, totalDue: row.principalDue + interest + row.feesDue }
    })
  }
  const owed = (path: RatePoint[]) => {
    const result = replay.replayAt(asOf, [], { schedule: candidate(path), contractRateHistory: path.map((point) => ({ effectiveDate: dbDate(point.effectiveDate), annualRate: point.annualRate })) })
    return result.lawfulSchedule!.reduce((sum, row) => sum + row.interestDue, 0) + result.interestAccrued + result.feesAccrued
  }
  return owed(newPath) - owed(oldPath)
}
