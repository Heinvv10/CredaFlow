import { sastStartOfDay } from "@/lib/date/sast"

/**
 * The status a writer stores after it recomputes a row's paid and due figures.
 * PARTIAL means money was applied to the row and some is still owed; a row
 * with nothing paid is PENDING. Writers that stored PARTIAL for every unpaid
 * row they touched marked a whole loan's future instalments "Partial".
 */
export function scheduleRowStatus(totalPaid: number, totalDue: number): "PAID" | "PARTIAL" | "PENDING" {
  if (totalPaid >= totalDue) return "PAID"
  return totalPaid > 0 ? "PARTIAL" : "PENDING"
}

export const SCHEDULE_DISPLAY_STATUSES = [
  "PAID",
  "PARTIAL",
  "OVERDUE",
  "DUE",
  "UPCOMING",
  "WRITTEN_OFF",
  "CANCELLED",
] as const
export type ScheduleDisplayStatus = (typeof SCHEDULE_DISPLAY_STATUSES)[number]

/**
 * What a schedule screen shows for a row. Derived from the figures, not the
 * stored PARTIAL alone, so rows a past writer mis-stored still read correctly:
 * nothing paid and not yet due is "Upcoming"; nothing paid and due today or
 * earlier is "Due". A row staff flagged OVERDUE keeps that flag.
 */
export function scheduleDisplayStatus(
  row: { status: string; totalPaid: number; totalDue: number; dueDate: Date | string },
  now: Date,
): ScheduleDisplayStatus {
  switch (row.status) {
    case "PAID":
    case "OVERDUE":
    case "WRITTEN_OFF":
    case "CANCELLED":
      return row.status
  }
  if (row.totalPaid >= row.totalDue) return "PAID"
  if (row.totalPaid > 0) return "PARTIAL"
  return sastStartOfDay(new Date(row.dueDate)) > sastStartOfDay(now) ? "UPCOMING" : "DUE"
}
