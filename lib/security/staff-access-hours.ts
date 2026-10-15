/**
 * Per-lender staff working hours (TenantConfig.staffAccessHours).
 *
 * One window per weekday, in SAST wall-clock time, or null for a closed day.
 * SAST is UTC+2 with no daylight saving (lib/date/sast.ts), so "now" is read
 * off a shifted UTC clock and never off the host's zone.
 *
 * A window is [start, end): open at `start`, closed at `end`. "24:00" is the
 * end of the day. A window may not wrap midnight; a shift that crosses it is
 * two windows on two days (e.g. Fri 22:00–24:00 and Sat 00:00–06:00).
 */
import { SAST_OFFSET_MS, sastParts } from "@/lib/date/sast"

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const
export type Weekday = (typeof WEEKDAYS)[number]
export type AccessWindow = { start: string; end: string }
export type StaffAccessHours = Record<Weekday, AccessWindow | null>

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$|^24:00$/

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number)
  return h * 60 + m
}

export function isWithinAccessHours(hours: StaffAccessHours, now: Date): boolean {
  // sastParts' weekday is 0 = Monday, the order WEEKDAYS uses.
  const window = hours[WEEKDAYS[sastParts(now).weekday]]
  if (!window) return false
  const shifted = new Date(now.getTime() + SAST_OFFSET_MS)
  const minute = shifted.getUTCHours() * 60 + shifted.getUTCMinutes()
  return minute >= minutesOf(window.start) && minute < minutesOf(window.end)
}

export type ParsedAccessHours = { ok: true; hours: StaffAccessHours } | { ok: false; error: string }

/** Validates an untrusted value (API body or stored JSON) into StaffAccessHours. */
export function parseStaffAccessHours(value: unknown): ParsedAccessHours {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "Working hours must give a window or 'closed' for each weekday." }
  }
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).filter((k) => !(WEEKDAYS as readonly string[]).includes(k))
  if (unknown.length > 0) return { ok: false, error: `Unknown weekday: ${unknown.join(", ")}.` }

  const hours = {} as StaffAccessHours
  for (const day of WEEKDAYS) {
    if (!Object.hasOwn(record, day)) return { ok: false, error: `Working hours are missing ${day}.` }
    const raw = record[day]
    if (raw === null) {
      hours[day] = null
      continue
    }
    const window = raw as Partial<AccessWindow> | undefined
    if (
      !window || typeof window !== "object"
      || typeof window.start !== "string" || typeof window.end !== "string"
      || !TIME.test(window.start) || !TIME.test(window.end)
    ) {
      return { ok: false, error: `${day}: times must be HH:MM (00:00 to 24:00).` }
    }
    if (minutesOf(window.start) >= minutesOf(window.end)) {
      return { ok: false, error: `${day}: the window must end after it starts, on the same day.` }
    }
    hours[day] = { start: window.start, end: window.end }
  }
  if (WEEKDAYS.every((day) => hours[day] === null)) {
    return { ok: false, error: "At least one day must be open. Clear working hours to allow any time." }
  }
  return { ok: true, hours }
}
