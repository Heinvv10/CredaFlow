import { sastCalendarDate, sastDayNumberStart, sastHour, sastParts } from "@/lib/date/sast"

/** Dunning goes out from 07:00 until 20:00 SAST: not before breakfast, not after the evening. */
export const DUNNING_SEND_FROM_HOUR = 7
export const DUNNING_SEND_UNTIL_HOUR = 20

/**
 * What the messaging retry sweep does with a queued DUNNING message right now
 * (Message.dunning, lib/messaging/dunning-category.ts):
 *  - "wait": outside 07:00-20:00 SAST (a late first failure whose last retry falls
 *    after midnight, a timer that stalled and flushes at 05:00). This applies to ALL
 *    dunning, staff reminders included: no night-time dunning.
 *  - "expire": the message was not sent by the end of its SAST creation day, and
 *    `expires` says its wording is dated ("due TOMORROW"), so a day late it is wrong
 *    and is dropped rather than sent. Only the automated reminders expire then; a
 *    staff reminder and a 60-DPD notice wait for the next window and get one
 *    in-window chance the next morning, expiring once that day's window is over
 *    (20:00 SAST). The sweep's blanket 24 hour expiry does not apply to dunning, or
 *    a message queued mid-morning would be dropped before that window opens.
 *  - "send": inside the window (and, if it expires, inside its day).
 */
export function dunningRetryVerdict(createdAt: Date, now: Date, expires: boolean): "send" | "wait" | "expire" {
  if (expires && sastCalendarDate(createdAt) < sastCalendarDate(now)) return "expire"
  if (!expires && now.getTime() >= lastChanceEnd(createdAt)) return "expire"
  const hour = sastHour(now)
  return hour >= DUNNING_SEND_FROM_HOUR && hour < DUNNING_SEND_UNTIL_HOUR ? "send" : "wait"
}

/** 20:00 SAST on the day after the message was created: the end of the last window a message that waits is given. */
function lastChanceEnd(createdAt: Date): number {
  const { year, month, day } = sastParts(createdAt)
  return sastDayNumberStart(year, month, day + 1).getTime() + DUNNING_SEND_UNTIL_HOUR * 3_600_000
}

/** The next 07:00 SAST after `now`: where a message that has to wait is rescheduled to, so it stops heading every batch. */
export function nextDunningWindowStart(now: Date): Date {
  const { year, month, day } = sastParts(now)
  const today = sastDayNumberStart(year, month, day).getTime() + DUNNING_SEND_FROM_HOUR * 3_600_000
  return new Date(now.getTime() < today ? today : today + 86_400_000)
}
