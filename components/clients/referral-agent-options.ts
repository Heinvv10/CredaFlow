// Flattens the `/api/agent-hub/agents` payload into a flat pick-list of referral
// codes for the client Edit form's "Referral agent" field.
//
// That endpoint returns every agent with ALL of its referral codes regardless of
// status. Only an ACTIVE code belonging to an ACTIVE agent may be assigned —
// the same predicate `resolveReferralCodeById` enforces server-side
// (lib/referral-agents/referrals.ts). Offering a retired code here would produce a
// picker whose selections the API rejects with a 400.

export type ReferralAgentsPayload = {
  agents?: Array<{
    status?: string | null
    displayName?: string | null
    referralCodes?: Array<{
      id?: string | null
      code?: string | null
      label?: string | null
      status?: string | null
    }> | null
  }> | null
} | null

export type ReferralCodeOption = {
  id: string
  label: string
}

export function toReferralCodeOptions(payload: ReferralAgentsPayload): ReferralCodeOption[] {
  const agents = Array.isArray(payload?.agents) ? payload.agents : []
  const options: ReferralCodeOption[] = []

  for (const agent of agents) {
    if (agent?.status !== "ACTIVE") continue
    const codes = Array.isArray(agent.referralCodes) ? agent.referralCodes : []
    for (const code of codes) {
      if (code?.status !== "ACTIVE") continue
      if (typeof code.id !== "string" || !code.id) continue
      const agentName = String(agent.displayName ?? "").trim() || "Unnamed agent"
      const codeText = String(code.code ?? "").trim()
      const campaign = String(code.label ?? "").trim()
      const suffix = [codeText, campaign].filter(Boolean).join(" · ")
      options.push({ id: code.id, label: suffix ? `${agentName} — ${suffix}` : agentName })
    }
  }

  return options.sort((a, b) => a.label.localeCompare(b.label))
}
