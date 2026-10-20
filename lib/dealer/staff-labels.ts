/** Plain-language labels for the staff dealer pages. */
import type {
  DealerCommissionLineKind, DealerCommissionRateSource, DealerCommissionReversalReason, DealerKind, DealerPayableRunStatus, DealerRole,
} from "@prisma/client"

export const DEALER_KIND_LABELS: Record<DealerKind, string> = { DEALER: "Dealer", BROKER: "Broker" }
export const DEALER_ROLE_LABELS: Record<DealerRole, string> = { DEALER_ADMIN: "Dealer admin", DEALER_SALES: "Sales" }

export const RUN_STATUS_LABELS: Record<DealerPayableRunStatus, string> = {
  PENDING_APPROVAL: "Awaiting approval", APPROVED: "Approved", RELEASED: "Paid", CANCELLED: "Cancelled",
}
export const RUN_STATUS_TONE: Record<DealerPayableRunStatus, "warning" | "info" | "success" | "neutral"> = {
  PENDING_APPROVAL: "warning", APPROVED: "info", RELEASED: "success", CANCELLED: "neutral",
}

export const LINE_KIND_LABELS: Record<DealerCommissionLineKind, string> = { EARNED: "Earned", REVERSED: "Clawed back" }
export const REVERSAL_REASON_LABELS: Record<DealerCommissionReversalReason, string> = {
  LOAN_SETTLED_EARLY: "settled early", LOAN_WRITTEN_OFF: "written off", LOAN_CANCELLED: "cancelled",
}
export const RATE_SOURCE_LABELS: Record<DealerCommissionRateSource, string> = {
  DEALER: "the dealer's own rate", TENANT_DEFAULT: "the lender's default rate", NONE: "no rate (no commission)",
}

/** 250 → "2.50%". */
export const bpsPercent = (bps: number) => `${(bps / 100).toFixed(2)}%`
