import { resolveBorrower, type Borrower, type BorrowerLoan } from "./borrower"
import { summariseCommission, type SummaryTotals } from "./summary"

export type StatementEvent = {
  id: string
  createdAt: Date
  agentId: string | null
  amountCents: number | null
  commissionCents: number | null
  commissionStatus: string
  metadata: unknown
}

export type StatementRow = {
  id: string
  createdAt: string
  agentId: string | null
  agentName: string
  /** False when the event carries no agentId, or one absent from the roster. */
  agentResolved: boolean
  borrower: Borrower | null
  principalCents: number | null
  commissionCents: number | null
  commissionStatus: string
}

/** One agent's slice of a multi-agent statement, with its own subtotal. */
export type StatementGroup = {
  agentId: string
  agentName: string
  /** False for a group that is not a real, resolvable payee. */
  attributed: boolean
  rows: StatementRow[]
  totals: SummaryTotals
}

/**
 * Name shown when an event carries an agentId that does not resolve against the
 * tenant's roster. A statement row like this is a data fault, not a payee — it
 * must never render as an empty cell that reads like a real name, and must
 * never be paid against.
 */
export const UNKNOWN_AGENT_NAME = "Unknown agent"

/**
 * Name shown when an event carries NO agentId at all (the agentId FK is
 * ON DELETE SET NULL, so this is what deleting an agent leaves behind).
 *
 * Deliberately distinct from UNKNOWN_AGENT_NAME: these are separate groups, and
 * labelling both "Unknown agent" put two identically-named subtotal lines
 * carrying different amounts in one payout workbook.
 */
export const UNASSIGNED_AGENT_NAME = "Unassigned"

/** Grouping key for rows with no agentId. Not a real agent id. */
export const UNKNOWN_AGENT_KEY = "__unknown__"

// Shared by the Statements tab preview (page.tsx) and the export route so the
// two can never drift apart — the on-screen table and the downloaded workbook
// must show the same rows for the same agent/period.
//
// agentNameById is required rather than optional: making it optional would let
// a caller silently produce a whole workbook of "Unknown agent" rows. A required
// param forces every call site to prove it has the roster.
export function buildStatementRows(
  events: StatementEvent[],
  loansById: Map<string, BorrowerLoan>,
  agentNameById: Map<string, string>,
): StatementRow[] {
  return events.map((event) => ({
    id: event.id,
    createdAt: event.createdAt.toISOString(),
    agentId: event.agentId,
    agentName: event.agentId ? (agentNameById.get(event.agentId) ?? UNKNOWN_AGENT_NAME) : UNASSIGNED_AGENT_NAME,
    agentResolved: Boolean(event.agentId && agentNameById.has(event.agentId)),
    borrower: resolveBorrower(event, loansById),
    principalCents: event.amountCents,
    commissionCents: event.commissionCents,
    commissionStatus: event.commissionStatus,
  }))
}

/**
 * Splits statement rows into one group per agent, each carrying its own
 * subtotal — the figure a payout is actually made against.
 *
 * Ordering is by agent name, NOT by amount: a statement is read to find a
 * specific agent, and a value-ordered list moves someone's block every period.
 * (The Overview "commission by agent" table sorts by value because it is a
 * ranking; this is not.)
 *
 * Rows whose agent could not be resolved are grouped under a single synthetic
 * entry rather than dropped — silently omitting them would make the per-agent
 * subtotals fail to reconcile against the grand total, with no visible cause.
 */
export function groupStatementRows(rows: StatementRow[]): StatementGroup[] {
  const groups = new Map<string, { agentName: string; rows: StatementRow[] }>()
  for (const row of rows) {
    const key = row.agentId ?? UNKNOWN_AGENT_KEY
    const group = groups.get(key) ?? { agentName: row.agentName, rows: [] }
    group.rows.push(row)
    groups.set(key, group)
  }
  return [...groups.entries()]
    .map(([agentId, group]) => ({
      agentId,
      agentName: group.agentName,
      // Every row in a group shares one agentId, so resolution is a property of
      // the group, not of the individual row.
      attributed: group.rows[0]?.agentResolved ?? false,
      rows: group.rows,
      totals: summariseCommission(group.rows),
    }))
    .sort((a, b) => a.agentName.localeCompare(b.agentName, "en-ZA"))
}

// Single conversion point for cents -> rands (addendum item 7): everything in
// the domain layer (StatementRow, SummaryTotals) stays integer cents; only a
// value about to become an Excel cell crosses to rands, and only through here.
export function centsToRands(cents: number | null): number {
  return (cents ?? 0) / 100
}

// Sanitises free-text (an agent display name may contain spaces and
// punctuation) into a filesystem/header-safe token so the Content-Disposition
// filename can't carry characters a browser or OS would choke on.
//
// Takes a SCOPE name, not strictly an agent name: a multi-agent export is named
// for its scope ("all-agents", "3-agents") through this same sanitiser, so there
// is one filename rule rather than two that can drift.
export function statementFilename(scopeName: string, periodLabel: string): string {
  const safeScope = scopeName.trim().replace(/[^a-zA-Z0-9]+/g, "-").replace(/(^-+|-+$)/g, "") || "agent"
  const safePeriod = periodLabel.trim().replace(/\s+to\s+/, "_")
  return `lms-statement-${safeScope}-${safePeriod}.xlsx`
}

/**
 * How a statement's scope is named, for the filename and the export summary.
 * Kept beside statementFilename so the two cannot describe one export
 * differently.
 */
export function statementScopeName(isAllAgents: boolean, agentNames: string[]): string {
  if (isAllAgents) return "all agents"
  if (agentNames.length === 1) return agentNames[0]
  return `${agentNames.length} agents`
}

/**
 * Whether a statement must attribute its rows to named agents — the Agent
 * column, the per-agent subtotals, and the "all selected" wording.
 *
 * Shared by the on-screen preview and the export route ON PURPOSE. These were
 * two separate expressions over two different inputs (the roster vs the fetched
 * groups) and they disagreed: selecting two agents when only one had events in
 * the period rendered a single-agent table on screen and a multi-agent workbook
 * in the download, for the same query.
 *
 * The compact single-agent shape is used ONLY when the statement provably
 * covers exactly one real, resolvable agent.
 */
export function isMultiAgentStatement(requestedAgentCount: number, groups: StatementGroup[]): boolean {
  if (requestedAgentCount > 1) return true
  if (groups.length > 1) return true
  return groups.some((group) => !group.attributed)
}
