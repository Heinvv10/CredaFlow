export function integrationTestResultMessage(result: {
  ok?: boolean
  simulated?: boolean
  error?: string
}): string {
  if (!result.ok) return result.error ?? "Test failed"
  // Provider-neutral: this same string now fronts the bureau and disbursement
  // tests as well as messaging, where "no message was sent" would itself be a
  // small untruth. What every caller needs to know is identical — the provider
  // was never contacted, so this result proves nothing about connectivity.
  if (result.simulated) return "Simulation successful — the provider was not contacted"
  return "Connection successful"
}

export function notificationLogDisplayStatus(status: string): {
  label: string
  tone: "success" | "simulation" | "failure"
} {
  if (status === "sent") return { label: "Sent", tone: "success" }
  if (status === "ok") return { label: "OK", tone: "success" }
  if (status === "simulated") return { label: "Simulated — not sent", tone: "simulation" }
  if (status === "review_required") return { label: "Review required — delivery unverified", tone: "simulation" }
  if (status === "failed") return { label: "Failed", tone: "failure" }
  return { label: status, tone: "failure" }
}
