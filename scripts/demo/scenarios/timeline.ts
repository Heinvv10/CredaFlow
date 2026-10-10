/**
 * Business-day timeline for a scenario: "day 2 at 10:00" means the second SA
 * business day after the start date (weekends and public holidays skipped, by
 * the same calendar the PASQ validity rules use), at that SAST wall time.
 *
 * The clock only ever moves forward (TOTP replay protection). A slot that is
 * already behind the clock — a slow VLM poll ran past it — is taken at the
 * current time instead of rewinding.
 */
import {
  addSouthAfricanBusinessDays,
  isSouthAfricanBusinessDate,
} from "../../../lib/compliance/sa-business-days"
import { now, setClock } from "../sim/clock"
import { log } from "../sim/env"

const SAST_OFFSET = "+02:00" // South Africa observes no DST.
/**
 * Real time allowed before each jump for work a route left running after it
 * answered (notifications, audit tails), so it is stamped at the time of the
 * action rather than at the next slot. Extraction is awaited explicitly.
 */
const SETTLE_MS = 1500

/** The first SA business day on or after `isoDate`. */
export function firstBusinessDay(isoDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) throw new Error(`"${isoDate}" is not YYYY-MM-DD`)
  let day = isoDate
  while (!isSouthAfricanBusinessDate(day)) day = addSouthAfricanBusinessDays(day, 1)
  return day
}

export class Timeline {
  /** Business day 0 of the scenario (YYYY-MM-DD, SAST). */
  readonly day0: string

  constructor(startDate: string) {
    this.day0 = firstBusinessDay(startDate)
  }

  /** YYYY-MM-DD of business day `n`. */
  date(n: number): string {
    return addSouthAfricanBusinessDays(this.day0, n)
  }

  /** Moves the clock to business day `n` at `hhmm` SAST (never backwards). */
  async at(n: number, hhmm: string): Promise<Date> {
    if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new Error(`"${hhmm}" is not HH:MM`)
    const target = new Date(`${this.date(n)}T${hhmm}:00${SAST_OFFSET}`)
    const current = now()
    if (current.getTime() >= target.getTime()) {
      log(`clock ${current.toISOString()} is already past day ${n} ${hhmm}; continuing at the current time`)
      return current
    }
    await new Promise((r) => setTimeout(r, SETTLE_MS))
    return setClock(target)
  }
}
