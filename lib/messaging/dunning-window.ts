import { sastCalendarDate, sastHour } from "@/lib/date/sast"

/** Dunning goes out from 07:00 until 20:00 SAST: not before breakfast, not after the evening. */
export const DUNNING_SEND_FROM_HOUR = 7
export const DUNNING_SEND_UNTIL_HOUR = 20

/**
 * What the messaging retry sweep does with a queued DUNNING message right now
 * (Message.dunning, lib/messaging/dunning-category.ts):
 *  - "expire": it was not sent by the end of its SAST creation day. Its copy is
 *    dated ("due TOMORROW"), so a day late it is wrong, and it is dropped rather
 *    than sent.
 *  - "wait": inside its day but outside 07:00-20:00 SAST (a late first failure whose
 *    last retry falls after midnight, a timer that stalled and flushes at 05:00):
 *    it stays due and goes at the next sweep inside the window.
 *  - "send": inside its day and the window.
 */
export function dunningRetryVerdict(createdAt: Date, now: Date): "send" | "wait" | "expire" {
  if (sastCalendarDate(createdAt) < sastCalendarDate(now)) return "expire"
  const hour = sastHour(now)
  return hour >= DUNNING_SEND_FROM_HOUR && hour < DUNNING_SEND_UNTIL_HOUR ? "send" : "wait"
}
