// MsgStatus values (schema): QUEUED, SENT, SIMULATED, DELIVERED, READ, FAILED, RETRYING,
// SUPPRESSED_BY_CONSENT, FAILED_PERMANENT, EXPIRED, BOUNCED.
export const TERMINAL_STATUSES = new Set([
  "SIMULATED", "RECONCILIATION_REQUIRED", "DELIVERED", "READ", "FAILED", "FAILED_PERMANENT", "SUPPRESSED_BY_CONSENT", "EXPIRED", "BOUNCED",
])
export const FAILED_STATUSES = new Set(["FAILED", "FAILED_PERMANENT", "SUPPRESSED_BY_CONSENT", "EXPIRED", "BOUNCED"])
// Statuses that confirm the message genuinely went out. SENT is deliberately
// included even though it isn't in TERMINAL_STATUSES (polling keeps going
// past SENT hoping for a delivery receipt) — if polling is exhausted while
// still sitting on SENT, that's still a real positive signal, unlike
// QUEUED/RETRYING (never left our system) or UNKNOWN (network error).
export const SUCCESS_STATUSES = new Set(["SENT", "DELIVERED", "READ"])

export function statusLabel(status: string): string {
  switch (status) {
    case "QUEUED": return "Queued"
    case "SENT": return "Sent"
    case "SIMULATED": return "Simulated — not sent"
    case "RECONCILIATION_REQUIRED": return "Manual reconciliation required — automatic retry blocked"
    case "DELIVERED":
    case "READ": return "Delivered"
    case "FAILED":
    case "FAILED_PERMANENT": return "Failed"
    case "SUPPRESSED_BY_CONSENT": return "Blocked by consent"
    case "EXPIRED": return "Expired"
    case "BOUNCED": return "Bounced"
    case "RETRYING": return "Retrying"
    default: return status
  }
}
