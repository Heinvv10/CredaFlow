export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral"

const STATUS_TONES: Record<string, StatusTone> = {
  ACTIVE: "success",
  APPROVED: "success",
  COMPLETED: "success",
  COMPLIANT: "success",
  DISBURSED: "success",
  PAID: "success",
  VERIFIED: "success",

  DRAFT: "neutral",
  INACTIVE: "neutral",
  PENDING: "neutral",

  SUBMITTED: "info",
  REVIEW: "info",
  IN_REVIEW: "info",

  UNDER_REVIEW: "warning",
  PARTIAL: "warning",
  RENEWAL: "warning",
  OVERDUE: "warning",
  PENDING_WRITE_OFF: "warning",

  CANCELLED: "danger",
  DEFAULTED: "danger",
  DECLINED: "danger",
  FAILED: "danger",
  LAPSED: "danger",
  REJECTED: "danger",
  REVERSED: "danger",
  WRITTEN_OFF: "danger",
}

export function getStatusTone(status: string | null | undefined): StatusTone {
  if (!status) return "neutral"
  return STATUS_TONES[status.toUpperCase()] ?? "neutral"
}

// Enum values like PENDING_WRITE_OFF have more than one underscore — a plain
// .replace("_", " ") only swaps the first, producing "PENDING WRITE_OFF".
export function formatStatusLabel(status: string): string {
  return status.replace(/_/g, " ")
}

/**
 * Pill tone per loan status. Unlisted statuses fall back to "neutral".
 *
 * DELIBERATELY not `getStatusTone`, which it disagrees with: a COMPLETED loan
 * reads "info" here rather than "success" (closing a loan is an outcome, not an
 * achievement to celebrate in green), and CANCELLED/WRITTEN_OFF read "neutral"
 * rather than "danger" (they are terminal book states, not live problems the
 * viewer must act on). Both mappings are in use; do not "unify" them without a
 * product decision — that silently recolours a live dashboard.
 */
export const loanStatusTone: Record<string, StatusTone> = {
  ACTIVE: "success",
  COMPLETED: "info",
  DEFAULTED: "danger",
  PENDING_WRITE_OFF: "warning",
  WRITTEN_OFF: "neutral",
  RESTRUCTURED: "warning",
  CANCELLED: "neutral",
}
