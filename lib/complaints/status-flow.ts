/**
 * What staff may do with a complaint next, and how its state reads. The
 * Complaint row has no "acknowledged" status: acknowledgement is its
 * acknowledgedAt (PATCH /api/complaints/[id] with `acknowledge: true`), so an
 * Open complaint that has one reads "Acknowledged".
 */
export type ComplaintAction =
  | "ACKNOWLEDGE"
  | "UNDER_INVESTIGATION"
  | "RESOLVED"
  | "ESCALATED"
  | "ESCALATED_OMBUD"
  | "CLOSED"

type ComplaintState = { status: string; acknowledgedAt: Date | string | null }

export const COMPLAINT_ACTION_LABELS: Record<ComplaintAction, string> = {
  ACKNOWLEDGE: "Acknowledged",
  UNDER_INVESTIGATION: "Under Investigation",
  RESOLVED: "Resolved",
  ESCALATED: "Escalated",
  ESCALATED_OMBUD: "Escalated to Ombud",
  CLOSED: "Closed",
}

const NEXT: Record<string, ComplaintAction[]> = {
  OPEN: ["UNDER_INVESTIGATION", "RESOLVED", "ESCALATED", "ESCALATED_OMBUD", "CLOSED"],
  UNDER_INVESTIGATION: ["RESOLVED", "ESCALATED", "ESCALATED_OMBUD", "CLOSED"],
  ESCALATED: ["UNDER_INVESTIGATION", "RESOLVED", "ESCALATED_OMBUD", "CLOSED"],
  ESCALATED_OMBUD: ["UNDER_INVESTIGATION", "RESOLVED", "CLOSED"],
  RESOLVED: ["CLOSED"],
  CLOSED: [],
}

export function nextComplaintActions(complaint: ComplaintState): ComplaintAction[] {
  const next = NEXT[complaint.status] ?? []
  return complaint.status === "OPEN" && !complaint.acknowledgedAt ? ["ACKNOWLEDGE", ...next] : next
}

/** The PATCH body for an action. */
export function complaintActionBody(action: ComplaintAction): { acknowledge: true } | { status: string } {
  return action === "ACKNOWLEDGE" ? { acknowledge: true } : { status: action }
}

export function complaintStatusLabel(complaint: ComplaintState): string {
  if (complaint.status === "OPEN" && complaint.acknowledgedAt) return "Acknowledged"
  return COMPLAINT_ACTION_LABELS[complaint.status as ComplaintAction] ?? (complaint.status === "OPEN" ? "Open" : complaint.status)
}

/**
 * The summary tiles. Each counts exactly the status tabs it names: the
 * "Escalated" tile is the Escalated and the Escalated to Ombud tabs together,
 * and says so.
 */
export function complaintTiles(complaints: readonly ComplaintState[]) {
  const count = (...statuses: string[]) => complaints.filter((c) => statuses.includes(c.status)).length
  return [
    { key: "total", label: "Total", value: complaints.length },
    { key: "open", label: "Open", value: count("OPEN") },
    { key: "underInvestigation", label: "Under Investigation", value: count("UNDER_INVESTIGATION") },
    { key: "resolved", label: "Resolved", value: count("RESOLVED") },
    { key: "escalated", label: "Escalated (incl. Ombud)", value: count("ESCALATED", "ESCALATED_OMBUD") },
  ] as const
}
