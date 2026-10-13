import type { DeclineCategory } from "@prisma/client"
import { DECLINE_CATEGORY_LABELS } from "@/lib/applications/decline-category"
import { decisionKind } from "@/lib/applications/decision-kind"
import { formatDate } from "@/lib/utils"

interface DecisionAuditSource {
  status: string
  // A decline stores its decision time and decider in approvedAt/approvedById
  // (see the decide route), so status, not approvedAt, says what was decided.
  approvedAt: Date | null
  approvedBy: { name: string | null } | null
  repaymentMethod: string | null
  declineCategory: DeclineCategory | null
}

export function decisionAuditItem(application: DecisionAuditSource) {
  const kind = decisionKind(application)
  if (!application.approvedAt || !kind) return null
  const decider = application.approvedBy?.name
  if (kind === "declined") {
    return {
      label: `Declined ${formatDate(application.approvedAt)}`,
      detail: `${decider ?? "Decline recorded"}${
        application.declineCategory ? ` • ${DECLINE_CATEGORY_LABELS[application.declineCategory]}` : ""
      }`,
      tone: "danger" as const,
    }
  }
  const repayment =
    application.repaymentMethod === "EFT"
      ? "EFT repayment"
      : application.repaymentMethod === "DEBIT_ORDER"
        ? "Debit-order repayment"
        : "Repayment method missing"
  return {
    label: `Approved ${formatDate(application.approvedAt)}`,
    detail: `${decider ?? "Approval recorded"} • ${repayment}`,
    tone: "success" as const,
  }
}
