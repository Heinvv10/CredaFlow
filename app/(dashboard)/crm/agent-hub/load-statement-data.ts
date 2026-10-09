import { prisma } from "@/lib/prisma"
import { loanIdsFromEvents } from "@/lib/agent-hub/borrower"
import { buildStatementRows, groupStatementRows, type StatementGroup } from "@/lib/agent-hub/statement"
import { summariseCommission, type SummaryTotals } from "@/lib/agent-hub/summary"
import type { AgentSelection } from "@/lib/agent-hub/agent-selection"

// Statements tab data assembly, colocated with page.tsx rather than under
// lib/agent-hub/ — every module there is deliberately I/O-free, and this one
// isn't. Called as one entry in page.tsx's existing Promise.all, so it keeps
// the same concurrency the inline version had: the events query runs
// alongside the page's other queries, and only the lookups that depend on its
// result are sequential.
//
// Same query shape and row-building (buildStatementRows) the export route uses
// independently, so the on-screen preview and the downloaded workbook can never
// show different rows for the same agents/period.
export async function loadStatementData(
  tenantId: string,
  selection: AgentSelection,
  fromUtc: Date,
  toUtc: Date,
): Promise<{ groups: StatementGroup[]; totals: SummaryTotals; requestedAgentCount: number; unknownAgentIds: string[] }> {
  // "none" queries nothing. Note this is NOT the same branch as "all" — see
  // lib/agent-hub/agent-selection.ts for why absence must never widen to
  // every agent.
  // "too-many" queries nothing for the same reason as "none": the page must not
  // run an unbounded lookup the export route would reject outright.
  if (selection.kind === "none" || selection.kind === "too-many") {
    return { groups: [], totals: summariseCommission([]), requestedAgentCount: 0, unknownAgentIds: [] }
  }

  const events = await prisma.referralEvent.findMany({
    where: {
      tenantId,
      eventType: "CONVERTED",
      createdAt: { gte: fromUtc, lt: toUtc },
      // "all" deliberately omits the agentId filter rather than passing the
      // whole roster in an `in` — a newly created agent is then included
      // without the roster query having to have seen it first.
      ...(selection.kind === "some" ? { agentId: { in: selection.agentIds } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, agentId: true, amountCents: true, commissionCents: true, commissionStatus: true, metadata: true },
  })

  const loanIds = loanIdsFromEvents(events)
  const [loans, agents] = await Promise.all([
    loanIds.length
      ? prisma.loan.findMany({
          where: { id: { in: loanIds }, tenantId },
          select: { id: true, reference: true, client: { select: { firstName: true, lastName: true } }, product: { select: { name: true } } },
        })
      : Promise.resolve([]),
    prisma.referralAgent.findMany({ where: { tenantId }, select: { id: true, displayName: true } }),
  ])

  const rows = buildStatementRows(
    events,
    new Map(loans.map((l) => [l.id, l])),
    new Map(agents.map((a) => [a.id, a.displayName])),
  )

  const rosterIds = new Set(agents.map((a) => a.id))
  return {
    groups: groupStatementRows(rows),
    // Grand total over every row, so it reconciles against the per-agent
    // subtotals rendered beside it.
    totals: summariseCommission(rows),
    // How many agents were ASKED for, not how many happen to have rows. The
    // export route derives its layout from the same number, so the preview and
    // the workbook cannot disagree about shape for one query.
    requestedAgentCount: selection.kind === "all" ? agents.length : selection.agentIds.length,
    // Ids the export route will fail closed on (404). Surfaced so the preview
    // cannot render a confident-looking partial statement for a selection the
    // download will refuse.
    unknownAgentIds: selection.kind === "some" ? selection.agentIds.filter((id) => !rosterIds.has(id)) : [],
  }
}
