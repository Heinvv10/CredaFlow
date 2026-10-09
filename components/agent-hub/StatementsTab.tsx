import { Fragment } from "react"
import Link from "next/link"
import { formatZAR } from "@/lib/loan-calculator"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { StatusBadge } from "@/components/agent-hub/StatusBadge"
import { ALL_AGENTS, selectedOptionValues, type AgentSelection } from "@/lib/agent-hub/agent-selection"
import { isMultiAgentStatement, type StatementGroup } from "@/lib/agent-hub/statement"
import type { SummaryTotals } from "@/lib/agent-hub/summary"

// Only what the picker actually renders. It previously took `loans` and
// `totals` as well, to label each option with the agent's all-time owed
// amount — removed because that figure is all-time while the statement below
// is period-scoped, so the two contradicted each other on one screen.
// Structural typing still accepts the wider object page.tsx passes.
type AgentOption = { agentId: string; agentName: string }

function money(cents: number | null) {
  if (!cents) return "—"
  return formatZAR(cents)
}

function when(iso: string) {
  return new Date(iso).toLocaleDateString("en-ZA", { timeZone: SAST_TIME_ZONE })
}

/**
 * Built as one string rather than JSX text interleaved with {expressions}.
 * The interleaved form lost the space after the singular/plural clause in the
 * production build only — the element tree kept it, so no test could see it.
 * Exported so the wording is assertable without rendering.
 */
export function unknownAgentSentence(count: number): string {
  // The only caller guards on `length > 0`, so production cannot reach this.
  // Guarded anyway because the function is exported: "0 selected agents are no
  // longer on this roster" is a false statement, and "-1 selected agents" is
  // nonsense. Returning nothing renders nothing, which is the truthful output
  // for "no unknown agents".
  if (!Number.isInteger(count) || count < 1) return ""
  const subject = count === 1 ? "1 selected agent is" : `${count} selected agents are`
  return `${subject} no longer on this tenant’s roster, so their rows are not included below and Export to Excel will refuse this selection.`
}

// No "use client": the agent/date picker is a plain GET form (same pattern as
// the Decision history filter in CommissionTab.tsx) and the export button is a
// plain link — neither needs client state, so this stays a server component.
// A <select multiple> submits repeated agentId params, which is why multi-agent
// selection did not require converting this to a client component.
export function StatementsTab({
  agents,
  selection,
  periodFrom,
  periodTo,
  groups,
  totals,
  requestedAgentCount,
  unknownAgentIds,
}: {
  agents: AgentOption[]
  selection: AgentSelection
  periodFrom: string
  periodTo: string
  groups: StatementGroup[]
  totals: SummaryTotals
  requestedAgentCount: number
  unknownAgentIds: string[]
}) {
  const selectedValues = selectedOptionValues(selection)
  const exportParams = new URLSearchParams({ from: periodFrom, to: periodTo })
  for (const value of selectedValues) exportParams.append("agentId", value)
  const noSelection = selection.kind === "none" || selection.kind === "too-many"
  const exportHref = noSelection ? null : `/api/agent-hub/statement/export?${exportParams.toString()}`

  // Shared with the export route so the screen and the download cannot render
  // the same query in two different shapes.
  const isMultiAgent = isMultiAgentStatement(requestedAgentCount, groups)
  const columnCount = isMultiAgent ? 7 : 6

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)]">
        <div className="border-b border-[var(--cf-border-subtle)] px-5 py-4">
          <h2 className="font-semibold text-[var(--cf-text)]">Agent statement</h2>
          <p className="mt-1 text-xs text-gray-500">Pick one agent, several, or all of them, plus a period — to see every referral that earned commission and export it as Excel.</p>
          <form action="/crm/agent-hub" method="get" className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="tab" value="statements" />
            <label className="block text-xs">
              <span className="font-bold uppercase tracking-wide text-gray-500">Agent</span>
              <span className="ml-2 font-normal normal-case tracking-normal text-gray-500">hold Ctrl (⌘ on Mac) to pick several</span>
              <select
                name="agentId"
                multiple
                size={6}
                defaultValue={selectedValues}
                className="mt-1 block min-w-[280px] rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)]"
              >
                <option value={ALL_AGENTS} className="font-bold">All agents</option>
                {agents.map((agent) => (
                  <option key={agent.agentId} value={agent.agentId}>{agent.agentName}</option>
                ))}
              </select>
            </label>
            <label className="block text-xs">
              <span className="font-bold uppercase tracking-wide text-gray-500">From</span>
              <input type="date" name="from" defaultValue={periodFrom} className="mt-1 block rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)]" />
            </label>
            <label className="block text-xs">
              <span className="font-bold uppercase tracking-wide text-gray-500">To</span>
              <input type="date" name="to" defaultValue={periodTo} className="mt-1 block rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)]" />
            </label>
            <button type="submit" className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-black">View statement</button>
            {exportHref ? (
              <a href={exportHref} className="rounded-lg border border-amber-400/30 px-4 py-2 text-sm font-semibold text-[var(--cf-warning)]">Export to Excel</a>
            ) : null}
          </form>
        </div>

        {unknownAgentIds.length > 0 ? (
          // The export route fails closed on these (404). Saying so here stops
          // the preview looking like a complete statement for the selection.
          //
          // One pre-built string, not text interleaved with {expressions}: the
          // interleaved form rendered "agent isno longer" in the production
          // build. The space survived the element tree — so the component test
          // asserting this sentence passed — and was dropped by the compiler
          // only in the built output. Nothing but looking at the page caught it.
          <p className="border-b border-[var(--cf-border-subtle)] px-5 py-3 text-xs text-[var(--cf-danger)]">
            {unknownAgentSentence(unknownAgentIds.length)}
          </p>
        ) : null}

        {noSelection ? (
          <p className="px-5 py-10 text-center text-sm text-gray-500">
            {selection.kind === "too-many"
              ? `That is more agents than one statement can name (${selection.count}). Use “All agents” instead.`
              : "Select one or more agents above — or “All agents” — to view a statement."}
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="bg-[var(--cf-surface-soft)] text-left text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    {isMultiAgent ? <th className="px-5 py-3">Agent</th> : null}
                    <th className="px-5 py-3">Date</th>
                    <th className="px-5 py-3">Borrower</th>
                    <th className="px-5 py-3">Product</th>
                    <th className="px-5 py-3">Principal</th>
                    <th className="px-5 py-3">Commission</th>
                    <th className="px-5 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--cf-border-subtle)]">
                  {groups.map((group) => (
                    <Fragment key={group.agentId}>
                      {group.rows.map((row) => (
                        <tr key={row.id} className="text-[var(--cf-text-secondary)]">
                          {isMultiAgent ? <td className="px-5 py-4 text-xs text-[var(--cf-text)]">{row.agentName}</td> : null}
                          <td className="px-5 py-4 text-xs text-gray-500">{when(row.createdAt)}</td>
                          <td className="px-5 py-4">
                            {row.borrower ? (
                              <>
                                <div className="text-[var(--cf-text)]">{row.borrower.clientName}</div>
                                <Link href={`/loans/${row.borrower.loanId}`} className="text-xs text-[var(--cf-warning)] hover:underline">{row.borrower.loanReference}</Link>
                              </>
                            ) : "—"}
                          </td>
                          <td className="px-5 py-4">{row.borrower?.productName ?? "—"}</td>
                          <td className="px-5 py-4">{money(row.principalCents)}</td>
                          <td className="px-5 py-4 font-semibold text-[var(--cf-warning)]">{money(row.commissionCents)}</td>
                          <td className="px-5 py-4"><StatusBadge tone={row.commissionStatus === "PAYABLE" || row.commissionStatus === "PAID" ? "green" : row.commissionStatus === "PENDING" ? "amber" : "red"}>{row.commissionStatus}</StatusBadge></td>
                        </tr>
                      ))}
                      {isMultiAgent ? (
                        // The figure a payout is made against, kept beside that
                        // agent's rows rather than only in the footer total.
                        <tr className="bg-[var(--cf-bg-raised)] text-xs">
                          <td className="px-5 py-2 font-bold text-[var(--cf-text)]" colSpan={columnCount - 2}>Subtotal — {group.agentName}</td>
                          <td className="px-5 py-2 font-bold text-[var(--cf-warning)]">{formatZAR(group.totals.netOwedCents)}</td>
                          <td className="px-5 py-2 text-gray-500">net owed</td>
                        </tr>
                      ) : null}
                    </Fragment>
                  ))}
                  {groups.length === 0 ? <tr><td colSpan={columnCount} className="px-5 py-10 text-center text-gray-500">No commission events for this selection in this period.</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="grid gap-4 border-t border-[var(--cf-border-subtle)] px-5 py-4 text-sm md:grid-cols-5">
              <TotalTile label="Pending" value={totals.pendingCents} />
              <TotalTile label="Payable" value={totals.payableCents} />
              <TotalTile label="Paid" value={totals.paidCents} />
              <TotalTile label="Clawed back" value={totals.reversedCents} danger={totals.reversedCents > 0} />
              <TotalTile label={isMultiAgent ? "Net owed (all selected)" : "Net owed"} value={totals.netOwedCents} emphasise />
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function TotalTile({ label, value, danger, emphasise }: { label: string; value: number; danger?: boolean; emphasise?: boolean }) {
  const tone = danger ? "text-[var(--cf-danger)]" : emphasise ? "text-[var(--cf-warning)]" : "text-[var(--cf-text)]"
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-1 font-bold ${tone}`}>{formatZAR(value)}</p>
    </div>
  )
}
