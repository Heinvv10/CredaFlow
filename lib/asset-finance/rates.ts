// Rate-path helpers. A rate path is a list of (effectiveDate, annualRate)
// points; the rate in effect on day d is that of the last point whose
// effectiveDate <= d (a change takes effect ON its effective date).
import { toDayNumber } from "./dates"
import type { RatePoint } from "./types"

interface RateSegment {
  fromDay: number // first day the rate applies
  annualRate: number
}

/**
 * Validates the path and returns it as day-numbered segments. The first point
 * must be in effect on `accrualStartDay` or earlier; points must be strictly
 * ascending; rates finite and >= 0.
 */
export function rateSegments(ratePath: RatePoint[], accrualStartDay: number): RateSegment[] {
  if (ratePath.length === 0) throw new RangeError("ratePath: at least one rate point is required")
  const segments = ratePath.map((point, i) => {
    if (!Number.isFinite(point.annualRate) || point.annualRate < 0) {
      throw new RangeError(`ratePath[${i}]: annualRate must be a finite decimal >= 0`)
    }
    return { fromDay: toDayNumber(point.effectiveDate, `ratePath[${i}].effectiveDate`), annualRate: point.annualRate }
  })
  segments.forEach((segment, i) => {
    if (i > 0 && segment.fromDay <= segments[i - 1].fromDay) {
      throw new RangeError("ratePath: effective dates must be strictly ascending")
    }
  })
  if (segments[0].fromDay > accrualStartDay) {
    throw new RangeError("ratePath: the first rate must be in effect on or before the accrual start date")
  }
  return segments
}

/**
 * Σ rate(d) over the days d in (afterDay, throughDay]: each segment's rate
 * times the number of the period's days it covers. Interest on a constant
 * balance for the period is balance × this sum / 365.
 */
export function rateDaySum(segments: RateSegment[], afterDay: number, throughDay: number): number {
  let sum = 0
  segments.forEach((segment, i) => {
    const first = Math.max(segment.fromDay, afterDay + 1)
    const last = Math.min(i + 1 < segments.length ? segments[i + 1].fromDay - 1 : throughDay, throughDay)
    if (last >= first) sum += segment.annualRate * (last - first + 1)
  })
  return sum
}
