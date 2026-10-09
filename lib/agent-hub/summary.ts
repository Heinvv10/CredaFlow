export type SummaryTotals = {
  pendingCents: number
  payableCents: number
  paidCents: number
  reversedCents: number
  /** Still to hand over: PENDING + PAYABLE. PAID has gone; REVERSED was never owed. */
  netOwedCents: number
}

type MoneyEvent = { commissionStatus: string; commissionCents: number | null }

export function summariseCommission(events: MoneyEvent[]): SummaryTotals {
  const t = { pendingCents: 0, payableCents: 0, paidCents: 0, reversedCents: 0, netOwedCents: 0 }
  for (const e of events) {
    const cents = e.commissionCents ?? 0
    // Allow-list: NOT_ELIGIBLE and BLOCKED carry no money, and a status added
    // later must not silently join a total.
    if (e.commissionStatus === "PENDING") t.pendingCents += cents
    else if (e.commissionStatus === "PAYABLE") t.payableCents += cents
    else if (e.commissionStatus === "PAID") t.paidCents += cents
    else if (e.commissionStatus === "REVERSED") t.reversedCents += cents
  }
  t.netOwedCents = t.pendingCents + t.payableCents
  return t
}

export function summariseByAgent<T extends MoneyEvent & { agentId: string | null; agentName: string }>(
  events: T[],
): { agentId: string; agentName: string; loans: number; totals: SummaryTotals }[] {
  const groups = new Map<string, { agentName: string; events: T[] }>()
  for (const e of events) {
    if (!e.agentId) continue
    const g = groups.get(e.agentId) ?? { agentName: e.agentName, events: [] }
    g.events.push(e)
    groups.set(e.agentId, g)
  }
  return [...groups.entries()]
    .map(([agentId, g]) => ({
      agentId, agentName: g.agentName, loans: g.events.length, totals: summariseCommission(g.events),
    }))
    .sort((a, b) => b.totals.netOwedCents - a.totals.netOwedCents)
}
