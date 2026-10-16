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
  "PARTIAL_OVERDUE",
  "OVERDUE",
  "DUE",
  "UPCOMING",
  "WRITTEN_OFF",
  "CANCELLED",
] as const
export type ScheduleDisplayStatus = (typeof SCHEDULE_DISPLAY_STATUSES)[number]

/** Badge text where the status key is not readable as it stands. */
export const SCHEDULE_STATUS_TEXT: Partial<Record<ScheduleDisplayStatus, string>> = {
  PARTIAL_OVERDUE: "PARTIAL · OVERDUE",
}

/** Past due, in red; a part-payment or a due-today row, in amber. */
export function scheduleStatusTone(status: ScheduleDisplayStatus): "success" | "danger" | "warning" | "neutral" {
  if (status === "PAID") return "success"
  if (status === "OVERDUE" || status === "PARTIAL_OVERDUE") return "danger"
  if (status === "PARTIAL" || status === "DUE") return "warning"
  return "neutral"
}

/**
 * What a schedule screen shows for a row, derived from the figures and the
 * due date, not the stored status (writers store an unpaid row PENDING, and
 * past writers mis-stored PARTIAL). Consistent with the lease views
 * (lib/asset-finance/portal-lease-view.ts): unpaid past its due date is
 * Overdue, part-paid past it is Partial · overdue; nothing paid and due today
 * is Due; not yet due is Upcoming. A row staff flagged OVERDUE stays overdue.
 */
export function scheduleDisplayStatus(
  row: { status: string; totalPaid: number; totalDue: number; dueDate: Date | string },
  now: Date,
): ScheduleDisplayStatus {
  switch (row.status) {
    case "PAID":
    case "WRITTEN_OFF":
    case "CANCELLED":
      return row.status
  }
  if (row.totalPaid >= row.totalDue) return "PAID"
  const today = sastStartOfDay(now).getTime()
  const due = sastStartOfDay(new Date(row.dueDate)).getTime()
  const pastDue = due < today || row.status === "OVERDUE"
  if (row.totalPaid > 0) return pastDue ? "PARTIAL_OVERDUE" : "PARTIAL"
  if (pastDue) return "OVERDUE"
  return due > today ? "UPCOMING" : "DUE"
}
