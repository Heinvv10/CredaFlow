export type SearchableAgent = {
  displayName: string
  email: string | null
  phone: string | null
  referralCodes: { code: string }[]
}

/**
 * Whether an agent matches a free-text search box. Twelve agents today, but
 * this is unusable at fifty without it. Case-insensitive substring match
 * against displayName, email, phone, and every code the agent holds — each
 * field checked independently, so a query can't match by spanning two fields.
 * A blank/whitespace-only query matches everything.
 */
export function matchesAgentSearch(agent: SearchableAgent, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const haystacks = [agent.displayName, agent.email, agent.phone, ...agent.referralCodes.map((code) => code.code)]
  return haystacks.some((value) => value?.toLowerCase().includes(needle))
}
