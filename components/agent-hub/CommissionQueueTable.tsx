import Link from "next/link"
import { formatZAR } from "@/lib/loan-calculator"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { StatusBadge } from "@/components/agent-hub/StatusBadge"
import { DecisionPanel } from "@/components/agent-hub/DecisionPanel"
import type { Borrower } from "@/lib/agent-hub/borrower"
import type { TriageSignal } from "@/lib/agent-hub/triage-signals"
import { formatDecidedLine, type LastDecision } from "@/lib/agent-hub/last-decision"
import { payableActionFor } from "@/lib/agent-hub/payable-action"
import type { DecisionAction } from "@/lib/agent-hub/decision-reasons"

export type ReferralEvent = {
  id: string
  eventType: string
  source: string | null
  amountCents: number | null
  commissionStatus: string
  commissionCents: number | null
  qualityFlag: string | null
  attributionRaw: string | null
  createdAt: string
  code: { code: string; label: string | null; agent: { displayName: string } } | null
  lead: { id: string; firstName: string; lastName: string; status: string; requestedAmount: number | null } | null
  borrower: Borrower | null
  signals: TriageSignal[]
  lastDecision: LastDecision | null
}

type Decision = { eventId: string; action: DecisionAction; presetReason?: string }

function money(cents: number | null) {
  if (!cents) return "—"
  return formatZAR(cents)
}

function when(iso: string) {
  return new Date(iso).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })
}

export function CommissionQueueTable({
  events,
  decision,
  setDecision,
  submitDecision,
}: {
  events: ReferralEvent[]
  decision: Decision | null
  setDecision: (decision: Decision | null) => void
  submitDecision: (eventId: string, action: DecisionAction, label: string, decisionNote: string) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-sm">
        <thead className="bg-[var(--cf-surface-soft)] text-left text-xs uppercase tracking-wide text-gray-500">
          <tr>
            <th className="px-5 py-3">Event</th>
            <th className="px-5 py-3">Agent/code</th>
            <th className="px-5 py-3">Borrower</th>
            <th className="px-5 py-3">Amount</th>
            <th className="px-5 py-3">Commission</th>
            <th className="px-5 py-3">Status</th>
            <th className="px-5 py-3">Decide</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--cf-border-subtle)]">
          {events.map((event) => (
            <tr key={event.id} className="text-[var(--cf-text-secondary)]">
              <td className="px-5 py-4"><div className="font-semibold text-[var(--cf-text)]">{event.eventType}</div><div className="text-xs text-gray-500">{when(event.createdAt)}</div></td>
              <td className="px-5 py-4">{event.code ? <><span className="font-mono text-[var(--cf-warning)]">{event.code.code}</span><div className="text-xs text-gray-500">{event.code.agent.displayName}</div></> : <span className="text-gray-500">{event.attributionRaw || "—"}</span>}</td>
              <td className="px-5 py-4">
                {event.borrower ? (
                  <>
                    <div className="text-[var(--cf-text)]">{event.borrower.clientName}</div>
                    <div className="text-xs text-gray-500">
                      <Link href={`/loans/${event.borrower.loanId}`} className="text-[var(--cf-warning)] hover:underline">{event.borrower.loanReference}</Link>
                      {event.borrower.productName ? ` · ${event.borrower.productName}` : null}
                    </div>
                  </>
                ) : event.lead ? (
                  <>
                    <Link href={`/crm/leads/${event.lead.id}`} className="text-[var(--cf-text)] hover:underline">{event.lead.firstName} {event.lead.lastName}</Link>
                    <div className="text-xs text-gray-500">{event.lead.status}</div>
                  </>
                ) : "—"}
                {event.signals.slice(0, 2).map((signal) => (
                  <div key={signal.kind} className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                    <span className={signal.severity === "high" ? "text-[var(--cf-danger)]" : "text-[var(--cf-warning)]"}>⚑ {signal.message}</span>
                    <button type="button" onClick={() => setDecision({ eventId: event.id, action: "BLOCKED", presetReason: signal.blockReason })} className="rounded border border-red-500/30 px-2 py-0.5 text-[var(--cf-danger)]">Block</button>
                    <button type="button" onClick={() => setDecision({ eventId: event.id, action: "PAYABLE", presetReason: signal.dismissReason })} className="rounded border border-emerald-500/30 px-2 py-0.5 text-[var(--cf-success)]">Looks fine</button>
                  </div>
                ))}
                {/* Rendered BESIDE the signals, never instead of them. A decided
                    row stays in the queue (Block leaves a qualityFlag the filter
                    still matches), so without this the next reviewer re-opens a
                    row someone already investigated, sees only the signal, and
                    is one click from re-deciding it blind. The recorded reason
                    is the answer to the question the signal asks. */}
                {event.lastDecision ? (
                  <div className="mt-1 text-xs text-[var(--cf-text-secondary)]">✓ {formatDecidedLine(event.lastDecision)}</div>
                ) : null}
              </td>
              <td className="px-5 py-4">{money(event.amountCents)}</td>
              <td className="px-5 py-4 font-semibold text-[var(--cf-warning)]">{money(event.commissionCents)}</td>
              <td className="px-5 py-4"><div className="flex flex-col gap-1"><StatusBadge tone={event.commissionStatus === "PENDING" ? "amber" : event.commissionStatus === "PAYABLE" ? "green" : "red"}>{event.commissionStatus}</StatusBadge>{event.qualityFlag ? <StatusBadge tone="red">{event.qualityFlag}</StatusBadge> : null}</div></td>
              <td className="px-5 py-4">
                {decision && decision.eventId === event.id ? (
                  <DecisionPanel
                    key={`${decision.action}:${decision.presetReason ?? ""}`}
                    action={decision.action}
                    presetReason={decision.presetReason}
                    onCancel={() => setDecision(null)}
                    onDone={(label, decisionNote) => submitDecision(event.id, decision.action, label, decisionNote)}
                  />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {/* payableActionFor builds the WHOLE payload — there is
                        deliberately no object literal here to add a preset
                        reason back into. That is the property that took two
                        review rounds to establish, and a call site cannot be
                        unit-tested in this repo (environment: "node", no jsdom),
                        so it is pinned in the helper instead. */}
                    <button
                      type="button"
                      onClick={() => {
                        const next = payableActionFor(event.id, event.signals)
                        return next.kind === "one-click"
                          ? submitDecision(event.id, "PAYABLE", "Mark payable commission", next.decisionNote)
                          : setDecision(next.decision)
                      }}
                      className="rounded border border-emerald-500/30 px-2 py-1 text-xs text-[var(--cf-success)]"
                    >
                      Mark payable
                    </button>
                    <button type="button" onClick={() => setDecision({ eventId: event.id, action: "BLOCKED" })} className="rounded border border-red-500/30 px-2 py-1 text-xs text-[var(--cf-danger)]">Block</button>
                    <button type="button" onClick={() => setDecision({ eventId: event.id, action: "REVIEW" })} className="rounded border border-[var(--cf-border-subtle)] px-2 py-1 text-xs text-[var(--cf-text-secondary)]">Review</button>
                  </div>
                )}
              </td>
            </tr>
          ))}
          {events.length === 0 ? <tr><td colSpan={7} className="px-5 py-10 text-center text-gray-500">No pending or flagged referral events.</td></tr> : null}
        </tbody>
      </table>
    </div>
  )
}
