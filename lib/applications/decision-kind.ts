/**
 * What the application's approvedAt/approvedById actually record. A decline
 * stores its decision time there too, and cancelling a declined application
 * leaves both it and declineCategory in place, so approvedAt alone proves
 * nothing about an approval.
 */
export function decisionKind(application: {
  status: string
  approvedAt: Date | null
  declineCategory: string | null
}): "approved" | "declined" | null {
  if (!application.approvedAt) return null
  if (application.status === "APPROVED" || application.status === "DISBURSED") return "approved"
  if (application.status === "DECLINED") return "declined"
  if (application.status === "CANCELLED" && application.declineCategory) return "declined"
  return null
}

export function portalDecisionLabel(application: Parameters<typeof decisionKind>[0]): string | null {
  const kind = decisionKind(application)
  return kind === "declined" ? "Application declined" : kind === "approved" ? "Application approved" : null
}

/**
 * A declined application is terminal, including one declined and then
 * cancelled (CANCELLED keeps declineCategory). It offers no Cancel action and
 * approval/payout blockers do not apply to it.
 */
export function isDeclinedTerminal(application: {
  status: string
  declineCategory: string | null
}): boolean {
  return application.status === "DECLINED" || (application.status === "CANCELLED" && !!application.declineCategory)
}
