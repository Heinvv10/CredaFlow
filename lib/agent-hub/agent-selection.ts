// Which agents a statement covers. The Statements tab submits a plain GET form
// with <select multiple name="agentId">, so the raw input is `string | string[]`
// (Next collapses a single occurrence to a string) — this is the one place that
// shape is turned into a decision.
//
// "none" is deliberately distinct from "all": an absent selector must show the
// "pick an agent" prompt, NOT silently export every agent's commission history.
// Defaulting absence to "all" would turn a bare /crm/agent-hub?tab=statements
// into a whole-roster POPIA access event that nobody asked for.

/**
 * Sentinel for "every agent in the tenant". Not a cuid, so it cannot collide
 * with a real ReferralAgent.id (cuids are lowercase alphanumeric and never
 * contain underscores).
 */
export const ALL_AGENTS = "__all__"

/**
 * Upper bound on how many agents one statement may name. Comfortably above any
 * real roster (production runs a dozen), but it stops an unbounded
 * `id: { in: [...] }` being built from arbitrary caller input — the only other
 * limit was the URL length the proxy happened to accept.
 */
export const MAX_SELECTED_AGENTS = 200

export type AgentSelection =
  | { kind: "none" }
  | { kind: "all" }
  | { kind: "some"; agentIds: string[] }
  | { kind: "too-many"; count: number }

export function parseAgentSelection(raw: string | string[] | undefined): AgentSelection {
  const values = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  // "All agents" wins over any co-selected ids. A browser can submit both when
  // the operator ctrl-clicks All plus a few names, and the widest of the two
  // readings is the one the UI visibly promised.
  if (values.includes(ALL_AGENTS)) return { kind: "all" }

  const agentIds = [...new Set(values)]
  // Checked AFTER de-duplication, so repeating one agent 500 times is not a
  // rejection — it is one agent.
  if (agentIds.length > MAX_SELECTED_AGENTS) return { kind: "too-many", count: agentIds.length }
  return agentIds.length > 0 ? { kind: "some", agentIds } : { kind: "none" }
}

/** The values a <select multiple> should show as selected for this selection. */
export function selectedOptionValues(selection: AgentSelection): string[] {
  if (selection.kind === "all") return [ALL_AGENTS]
  return selection.kind === "some" ? selection.agentIds : []
}
