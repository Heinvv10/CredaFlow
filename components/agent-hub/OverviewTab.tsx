import { formatZAR } from "@/lib/loan-calculator"
import { TenantCommissionRateEditor } from "@/components/agent-hub/TenantCommissionRateEditor"
import type { SummaryTotals } from "@/lib/agent-hub/summary"

type AgentTotals = { agentId: string; agentName: string; loans: number; totals: SummaryTotals }

type OverviewAgent = {
  id: string
  displayName: string
  commissionBps: number | null
  referralCodes: { status: string }[]
}

export function OverviewTab({
  summary,
  byAgent,
  attention,
  agents,
  tenantCommissionBps,
  canEditTenantRate,
}: {
  summary: SummaryTotals
  byAgent: AgentTotals[]
  attention: { unmatchedCodesCount: number; flaggedEventsCount: number }
  agents: OverviewAgent[]
  tenantCommissionBps: number
  canEditTenantRate: boolean
}) {
  // Not part of `attention` because it's derived from the same agent list this
  // panel already has, not a separate query — one fewer round trip.
  const agentsWithoutActiveCode = agents.filter((agent) => !agent.referralCodes.some((code) => code.status === "ACTIVE"))

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6">
        <p className="text-xs font-bold uppercase tracking-wide text-amber-500">Net owed to agents</p>
        <p className="mt-2 text-4xl font-bold text-[var(--cf-text)]">{formatZAR(summary.netOwedCents)}</p>
        <p className="mt-1 text-xs text-gray-500">Pending + payable — accrued commission not yet paid out.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <MoneyTile label="Pending" value={summary.pendingCents} />
        <MoneyTile label="Payable" value={summary.payableCents} />
        <MoneyTile label="Paid" value={summary.paidCents} />
        <MoneyTile label="Clawed back" value={summary.reversedCents} danger={summary.reversedCents > 0} />
      </div>

      <section className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)]">
        <div className="border-b border-[var(--cf-border-subtle)] px-5 py-4">
          <h2 className="font-semibold text-[var(--cf-text)]">Commission by agent</h2>
        </div>
        {byAgent.length === 0 ? (
          <p className="px-5 py-6 text-sm text-gray-500">No commission events yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-[var(--cf-surface-soft)] text-left text-xs uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-5 py-3">Agent</th>
                  <th className="px-5 py-3">Loans</th>
                  <th className="px-5 py-3">Pending</th>
                  <th className="px-5 py-3">Payable</th>
                  <th className="px-5 py-3">Net owed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--cf-border-subtle)]">
                {byAgent.map((agent) => (
                  <tr key={agent.agentId} className="text-[var(--cf-text-secondary)]">
                    <td className="px-5 py-3 font-semibold text-[var(--cf-text)]">{agent.agentName}</td>
                    <td className="px-5 py-3">{agent.loans}</td>
                    <td className="px-5 py-3">{formatZAR(agent.totals.pendingCents)}</td>
                    <td className="px-5 py-3">{formatZAR(agent.totals.payableCents)}</td>
                    <td className="px-5 py-3 font-semibold text-[var(--cf-text)]">{formatZAR(agent.totals.netOwedCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-5">
        <h2 className="font-semibold text-[var(--cf-text)]">Needs attention</h2>
        <ul className="mt-3 space-y-2 text-sm">
          <AttentionRow label="Unmatched referral codes" count={attention.unmatchedCodesCount} />
          <AttentionRow label="Flagged events" count={attention.flaggedEventsCount} />
          <AttentionRow
            label="Agents with no active code"
            count={agentsWithoutActiveCode.length}
            detail={agentsWithoutActiveCode.map((agent) => agent.displayName).join(", ")}
          />
        </ul>
      </section>

      {/* Commission being off is otherwise invisible: the accrual hook silently
          no-ops and every figure on this page stays at zero, which reads as "no
          referrals yet" rather than "nobody is being paid". Shown to everyone who
          can see this page, not just whoever can change it. */}
      {/* `!= null`, not a truthy check: an agent set to 0 bps earns nothing by a
          deliberate decision, not by inheriting this default — the same rule
          resolveEffectiveBps applies. Treating that 0 as "no override" would show
          this warning to a tenant whose agents are all priced on purpose. */}
      {tenantCommissionBps === 0 && !agents.every((agent) => agent.commissionBps != null) ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-5">
          <p className="text-sm font-bold text-[var(--cf-danger)]">Commission is switched off</p>
          <p className="mt-1 max-w-3xl text-xs text-[var(--cf-text-secondary)]">
            The default rate is 0%, and agents without their own rate earn nothing when a
            referred loan is disbursed — no event is recorded and no warning is raised.
            {canEditTenantRate ? " Set a rate below to start accruing." : " An ADMIN can set a rate on this page."}
          </p>
        </div>
      ) : null}

      {canEditTenantRate ? <TenantCommissionRateEditor initialBps={tenantCommissionBps} /> : null}
    </div>
  )
}

function MoneyTile({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-5">
      <p className="text-xs uppercase tracking-wide text-gray-500">{label}</p>
      <p className={`mt-2 text-2xl font-bold ${danger ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"}`}>{formatZAR(value)}</p>
    </div>
  )
}

function AttentionRow({ label, count, detail }: { label: string; count: number; detail?: string }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-[var(--cf-border-subtle)] px-3 py-2">
      <div>
        <span className="text-[var(--cf-text-secondary)]">{label}</span>
        {detail && count > 0 ? <span className="ml-2 text-xs text-gray-500">{detail}</span> : null}
      </div>
      <span className={`text-sm font-bold ${count > 0 ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"}`}>{count}</span>
    </li>
  )
}
