import { addSouthAfricanBusinessDays, easterSunday, isSouthAfricanBusinessDate } from "@/lib/compliance/sa-business-days"
import { activeJurisdiction } from "./active"
import type { Jurisdiction } from "./profiles"

/**
 * Business days for DUE-DATE logic (debit-order dates, submission windows),
 * by jurisdiction. ZA delegates to the South African calendar untouched. The
 * NCA statutory deadlines (Section 129, asset-finance notices) keep calling
 * lib/compliance/sa-business-days.ts directly: they are South African law.
 *
 * Lesotho holidays: 1 Jan, 11 Mar (Moshoeshoe's Day), Good Friday, Easter
 * Monday, 4 Apr (Heroes' Day), 1 May, Ascension Day (Easter + 39), 25 May
 * (Africa Day), 17 Jul (King's Birthday), 4 Oct (Independence Day), 25 and
 * 26 Dec. MEDIUM confidence, compiled from published calendars, not the
 * statute. Two things are NOT modelled and need the lender to confirm: a
 * Sunday holiday moving to the Monday, and one-off proclaimed days (the
 * South African equivalent is the SaProclaimedPublicHoliday table). A day
 * missing here sends a debit on a bank holiday; add it to LESOTHO_FIXED.
 */
const LESOTHO_FIXED = ["01-01", "03-11", "04-04", "05-01", "05-25", "07-17", "10-04", "12-25", "12-26"] as const

function parseDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError("Invalid ISO calendar date")
  const parsed = new Date(`${value}T12:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime())) throw new RangeError("Invalid ISO calendar date")
  return parsed
}

function shiftDay(value: string, days: number): string {
  const date = parseDay(value)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function lesothoPublicHolidays(year: number): Set<string> {
  const easter = easterSunday(year)
  return new Set([
    ...LESOTHO_FIXED.map((monthDay) => `${year}-${monthDay}`),
    shiftDay(easter, -2),
    shiftDay(easter, 1),
    shiftDay(easter, 39),
  ])
}

export function isBusinessDate(day: string, jurisdiction: Jurisdiction = activeJurisdiction()): boolean {
  if (jurisdiction === "ZA") return isSouthAfricanBusinessDate(day)
  const date = parseDay(day)
  const weekday = date.getUTCDay()
  if (weekday === 0 || weekday === 6) return false
  return !lesothoPublicHolidays(date.getUTCFullYear()).has(day)
}

export function addBusinessDays(start: string, businessDays: number, jurisdiction: Jurisdiction = activeJurisdiction()): string {
  if (jurisdiction === "ZA") return addSouthAfricanBusinessDays(start, businessDays)
  if (!Number.isSafeInteger(businessDays) || businessDays < 0) {
    throw new RangeError("Business-day count must be a non-negative integer")
  }
  parseDay(start)
  let day = start
  let remaining = businessDays
  while (remaining > 0) {
    day = shiftDay(day, 1)
    if (isBusinessDate(day, jurisdiction)) remaining -= 1
  }
  return day
}
