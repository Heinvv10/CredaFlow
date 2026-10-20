import { sastHour } from "@/lib/date/sast"
import { DUNNING_SEND_FROM_HOUR, DUNNING_SEND_UNTIL_HOUR } from "@/lib/messaging/dunning-window"

/**
 * The dunning send window (07:00-20:00 SAST, lib/messaging/dunning-window.ts) for
 * the crons that SEND: the reminders run refuses to start outside it, and
 * escalation flips statuses but sends no notice. The scheduler fires both inside
 * it; this stops a manual call with the cron secret at night from messaging
 * borrowers. The retry sweep applies the same hours to what is queued.
 */
export function outsideDunningSendWindow(now: Date): boolean {
  const hour = sastHour(now)
  return hour < DUNNING_SEND_FROM_HOUR || hour >= DUNNING_SEND_UNTIL_HOUR
}

export const DUNNING_SEND_WINDOW_LABEL =
  `${String(DUNNING_SEND_FROM_HOUR).padStart(2, "0")}:00-${DUNNING_SEND_UNTIL_HOUR}:00 SAST`
