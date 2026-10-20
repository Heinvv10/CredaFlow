import { sastStartOfDay } from "@/lib/date/sast"

/**
 * When each reminder fires, and the one test of "this is the day": the reminders
 * cron (lib/collections/reminders.ts, `TRIGGERS`) sends a trigger when the loan's
 * next payment date is `daysUntilDue` SAST days away, and the messaging retry sweep
 * (lib/collections/client-holds.ts, `loanDunningHold`) asks the same question of a
 * queued reminder. Kept in a module with no other imports because the cron imports
 * the hold module, and the hold module cannot import the cron.
 */
export const REMINDER_DAYS_UNTIL_DUE = {
  reminder_7d: 7,
  reminder_1d: 1,
  reminder_0d: 0,
  reminder_overdue_1d: -1,
  reminder_overdue_3d: -3,
} as const

/** Days from `a` to `b` as SAST calendar days (negative when `b` is earlier). */
export function sastDaysBetween(a: Date, b: Date): number {
  const msPerDay = 86_400_000
  return Math.round((sastStartOfDay(b).getTime() - sastStartOfDay(a).getTime()) / msPerDay)
}

/** The days-until-due a reminder's `noteType` fires at, or undefined for one that is not a cron trigger. */
export function reminderDaysUntilDue(noteType: string): number | undefined {
  return Object.hasOwn(REMINDER_DAYS_UNTIL_DUE, noteType) ? (REMINDER_DAYS_UNTIL_DUE as Record<string, number>)[noteType] : undefined
}
