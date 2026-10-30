import { SAST_OFFSET_MS } from "@/lib/date/sast"
import type { Frequency } from "./types"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The due date `k` periods after `start`, on the South African calendar. WEEKLY and FORTNIGHTLY are exactly 7k and 14k
 * days. MONTHLY keeps the day of the month and clamps to the month's last day (31 Jan -> 28 Feb -> 31 Mar), unlike
 * Date#setMonth, which spills 31 Jan + 1 month into March. The time of day of `start` is kept.
 */
export function addPeriods(start: Date, frequency: Frequency, k: number): Date {
  if (frequency === "WEEKLY") return new Date(start.getTime() + 7 * k * DAY_MS)
  if (frequency === "FORTNIGHTLY") return new Date(start.getTime() + 14 * k * DAY_MS)
  return addCalendarMonths(start, k)
}

/** `months` calendar months after `start` (SAST), day of month clamped. */
export function addCalendarMonths(start: Date, months: number): Date {
  const shifted = new Date(start.getTime() + SAST_OFFSET_MS)
  const index = shifted.getUTCFullYear() * 12 + shifted.getUTCMonth() + months
  const year = Math.floor(index / 12)
  const month = ((index % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  const day = Math.min(shifted.getUTCDate(), lastDay)
  const timeOfDay = shifted.getTime() - Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate())
  return new Date(Date.UTC(year, month, day) + timeOfDay - SAST_OFFSET_MS)
}
