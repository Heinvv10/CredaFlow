import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Dealer draft cancel and purge (docs/asset-finance/SLICE5-FOLLOWUPS.md part D).
  // The purge is a system action: no userId, counts only.
  DEALER_DEAL_CANCELLED: "DEALER_DEAL_CANCELLED",
  DEALER_DEAL_PURGED: "DEALER_DEAL_PURGED",
} as const)
