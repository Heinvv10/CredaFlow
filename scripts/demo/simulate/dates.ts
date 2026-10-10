/**
 * Calendar arithmetic on SAST calendar days ("YYYY-MM-DD" strings), with the
 * same SA business-day calendar the product's PASQ rules use.
 */
import { isSouthAfricanBusinessDate, southAfricanCalendarDate } from "../../../lib/compliance/sa-business-days"

const DAY_MS = 86_400_000

function parse(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`"${day}" is not YYYY-MM-DD`)
  return new Date(`${day}T00:00:00Z`)
}

export function addDays(day: string, n: number): string {
  return new Date(parse(day).getTime() + n * DAY_MS).toISOString().slice(0, 10)
}

/** Same day-of-month `n` months on, clamped to the month's last day. */
export function addMonths(day: string, n: number): string {
  const d = parse(day)
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1))
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate()
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay))
  return target.toISOString().slice(0, 10)
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / DAY_MS)
}

export const isBusinessDay = (day: string): boolean => isSouthAfricanBusinessDate(day)

/** The first business day on or after `day`. */
export function nextBusinessDay(day: string): string {
  let d = day
  while (!isBusinessDay(d)) d = addDays(d, 1)
  return d
}

/** The last business day on or before `day`. */
export function prevBusinessDay(day: string): string {
  let d = day
  while (!isBusinessDay(d)) d = addDays(d, -1)
  return d
}

/** `n` business days after (n > 0) or before (n < 0) `day`. */
export function shiftBusinessDays(day: string, n: number): string {
  let d = day
  let left = Math.abs(n)
  while (left > 0) {
    d = addDays(d, Math.sign(n))
    if (isBusinessDay(d)) left--
  }
  return d
}

/** Today's SAST calendar day on the REAL clock (the bake ends "now"). */
export function realToday(): string {
  return southAfricanCalendarDate(new Date())
}

export const sastInstant = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00+02:00`)
