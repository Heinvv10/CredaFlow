export function notificationLogStatusFromMessage(
  status: string,
): "sent" | "simulated" | "pending" | "failed" {
  if (status === "SIMULATED") return "simulated"
  if (["SENT", "DELIVERED", "READ"].includes(status)) return "sent"
  if (["QUEUED", "RETRYING"].includes(status)) return "pending"
  if (
    ["FAILED", "FAILED_PERMANENT", "BOUNCED", "EXPIRED", "SUPPRESSED_BY_CONSENT"].includes(status)
  ) {
    return "failed"
  }
  throw new Error(`sendMessage returned an unrecognised status: ${status}`)
}

export function notificationLogStatusFromProviderResult(result: {
  ok: boolean
  simulated?: boolean
  providerOutcome?: "ACCEPTED" | "DEFINITELY_REJECTED" | "AMBIGUOUS"
}): "sent" | "simulated" | "failed" | "review_required" {
  if (result.providerOutcome === "AMBIGUOUS") return "review_required"
  if (!result.ok || result.providerOutcome === "DEFINITELY_REJECTED") return "failed"
  return result.simulated === true ? "simulated" : "sent"
}
