"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { ReferralClawbacks, type ClawbackEvent } from "@/components/agent-hub/ReferralClawbacks"
import { SAST_TIME_ZONE } from "@/lib/utils"
import { formatZAR } from "@/lib/loan-calculator"
import { StatusBadge } from "@/components/agent-hub/StatusBadge"
import { CommissionQueueTable, type ReferralEvent } from "@/components/agent-hub/CommissionQueueTable"
import type { DecisionAction } from "@/lib/agent-hub/decision-reasons"

// Byte-identical to the three hardcoded PATCH bodies this replaces — only
// decisionNote now varies by reason instead of being a fixed string.
const DECISION_FIELDS: Record<DecisionAction, { commissionStatus: string; qualityFlag: string }> = {
  PAYABLE: { commissionStatus: "PAYABLE", qualityFlag: "APPROVED" },
  BLOCKED: { commissionStatus: "BLOCKED", qualityFlag: "LOW_QUALITY" },
  REVIEW: { commissionStatus: "PENDING", qualityFlag: "MANUAL_REVIEW" },
}

type HistoryEvent = {
  id: string
  eventType: string
  commissionCents: number | null
  code: { code: string; label: string | null; agent: { displayName: string } } | null
  lead: { id: string; firstName: string; lastName: string } | null
}

type HistoryRow = {
  auditId: string
  decidedByEmail: string | null
  decidedAt: string
  commissionStatus: string | null
  qualityFlag: string | null
  decisionNote: string | null
  event: HistoryEvent | null
}

function money(cents: number | null) {
  if (!cents) return "—"
  return formatZAR(cents)
}

function when(iso: string) {
  return new Date(iso).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })
}

async function jsonFetch(url: string, init: RequestInit) {
  const res = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

// `from`/`to`/`page` are server-component search params (see
// app/(dashboard)/crm/agent-hub/page.tsx), not client state — the same
// pattern the `tab` param already uses. The queue itself ignores `from`/`to`
// (owner ruling: it always shows everything outstanding), but a queue-page
// link still carries them so paging through the queue doesn't reset the
// Decision history date filter underneath it. `tab=commission` is carried on
// every link so the navigation lands back on this tab.
function queueHref(from: string, to: string, page: number) {
  const params = new URLSearchParams({ tab: "commission", from, to })
  if (page > 1) params.set("page", String(page))
  return `/crm/agent-hub?${params.toString()}`
}

export function CommissionTab({
  events,
  clawbacks,
  history,
  historyTotal,
  page,
  totalPages,
  periodFrom,
  periodTo,
}: {
  events: ReferralEvent[]
  clawbacks: ClawbackEvent[]
  history: HistoryRow[]
  historyTotal: number
  page: number
  totalPages: number
  periodFrom: string
  periodTo: string
}) {
  const router = useRouter()
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [decision, setDecision] = useState<{ eventId: string; action: DecisionAction; presetReason?: string } | null>(null)

  // Preserved as-is from the pre-split queue: an event keeps any qualityFlag
  // (including "APPROVED", set by Mark payable below) after it leaves PENDING,
  // so a just-approved/blocked row can still match here. Product has flagged
  // this as worth revisiting but ruled it out of scope for this change.
  const pendingEvents = useMemo(() => events.filter((event) => event.commissionStatus === "PENDING" || event.qualityFlag), [events])

  // Reports success/failure (never rejects) so callers can act only on the
  // outcome that actually happened — see submitDecision below.
  async function run(label: string, fn: () => Promise<unknown>): Promise<boolean> {
    setMessage(null)
    setError(null)
    try {
      await fn()
      setMessage(`${label} completed`)
      router.refresh()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : `${label} failed`)
      return false
    }
  }

  // Single request shape for both the one-click Mark payable path and the
  // DecisionPanel — the status/flag pairs never change per action, only
  // decisionNote does. The panel is closed only on success: a failed PATCH
  // must leave the reviewer's selected preset and typed note in place
  // alongside the error banner, not discard them.
  function submitDecision(eventId: string, action: DecisionAction, label: string, decisionNote: string) {
    return run(`${label} ${eventId}`, () => jsonFetch(`/api/agent-hub/referral-events/${eventId}`, {
      method: "PATCH",
      body: JSON.stringify({ ...DECISION_FIELDS[action], decisionNote }),
    })).then((ok) => { if (ok) setDecision(null) })
  }

  return (
    <div className="space-y-6">
      {(message || error) ? (
        <div className={`rounded-xl border p-4 text-sm font-semibold ${error ? "border-red-500/30 bg-red-500/10 text-[var(--cf-danger)]" : "border-emerald-500/30 bg-emerald-500/10 text-[var(--cf-success)]"}`}>
          {error ?? message}
        </div>
      ) : null}

      <section className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)]">
        <div className="border-b border-[var(--cf-border-subtle)] px-5 py-4">
          <h2 className="font-semibold text-[var(--cf-text)]">Commission and quality queue</h2>
          {/* RULE: this queue must never hide outstanding
              work by calendar default, so it is NOT scoped by the date filter
              below — that filter only narrows the Decision history section.
              Said explicitly so a staff member who changes the date range and
              sees this count unchanged doesn't read it as a bug. */}
          <p className="mt-1 text-xs text-gray-500">Every pending or flagged event, across all time — the date filter below only narrows Decision history, not this queue.</p>
        </div>
        <CommissionQueueTable events={pendingEvents} decision={decision} setDecision={setDecision} submitDecision={submitDecision} />
        <div className="flex items-center justify-between border-t border-[var(--cf-border-subtle)] px-5 py-3 text-xs text-gray-500">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            {page > 1 ? <Link href={queueHref(periodFrom, periodTo, page - 1)} className="rounded border border-[var(--cf-border-subtle)] px-3 py-1 text-[var(--cf-text-secondary)]">Previous</Link> : <span className="rounded border border-[var(--cf-border-subtle)] px-3 py-1 opacity-40">Previous</span>}
            {page < totalPages ? <Link href={queueHref(periodFrom, periodTo, page + 1)} className="rounded border border-[var(--cf-border-subtle)] px-3 py-1 text-[var(--cf-text-secondary)]">Next</Link> : <span className="rounded border border-[var(--cf-border-subtle)] px-3 py-1 opacity-40">Next</span>}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)]">
        <div className="border-b border-[var(--cf-border-subtle)] px-5 py-4">
          <h2 className="font-semibold text-[var(--cf-text)]">Decision history</h2>
          <p className="mt-1 text-xs text-gray-500">
            Every commission decision, who made it, and when — from the audit log (the event row carries no decidedBy/decidedAt; the audit log is the legal record).
            {historyTotal > history.length ? ` Showing the latest ${history.length} of ${historyTotal} in this period — narrow the date range to see the rest.` : null}
          </p>
          {/* Positioned inside this section, not above the queue: this date
              range scopes Decision history only (owner ruling above). */}
          <form action="/crm/agent-hub" method="get" className="mt-3 flex flex-wrap items-end gap-3">
            <input type="hidden" name="tab" value="commission" />
            <label className="block text-xs">
              <span className="font-bold uppercase tracking-wide text-gray-500">History from</span>
              <input type="date" name="from" defaultValue={periodFrom} className="mt-1 block rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)]" />
            </label>
            <label className="block text-xs">
              <span className="font-bold uppercase tracking-wide text-gray-500">History to</span>
              <input type="date" name="to" defaultValue={periodTo} className="mt-1 block rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-bg-raised)] px-3 py-2 text-sm text-[var(--cf-text)]" />
            </label>
            <button type="submit" className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-black">Apply</button>
          </form>
        </div>
        <div className="overflow-x-auto">
          {/* 1140, not 900: the Reason column below adds a 240px cell, and the
              seven-column width would otherwise crush every other column to fit. */}
          <table className="w-full min-w-[1140px] text-sm">
            <thead className="bg-[var(--cf-surface-soft)] text-left text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-5 py-3">Event</th>
                <th className="px-5 py-3">Agent/code</th>
                <th className="px-5 py-3">Lead</th>
                <th className="px-5 py-3">Commission</th>
                <th className="px-5 py-3">Decision</th>
                {/* The reason is the point of the register: without this column
                    every decisionNote this feature captures is database-only,
                    unreadable by the staff who wrote it. */}
                <th className="px-5 py-3">Reason</th>
                <th className="px-5 py-3">Decided by</th>
                <th className="px-5 py-3">Decided at</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--cf-border-subtle)]">
              {history.map((row) => (
                <tr key={row.auditId} className="text-[var(--cf-text-secondary)]">
                  <td className="px-5 py-4">{row.event ? row.event.eventType : <span className="text-gray-500">Event no longer available</span>}</td>
                  <td className="px-5 py-4">{row.event?.code ? <><span className="font-mono text-[var(--cf-warning)]">{row.event.code.code}</span><div className="text-xs text-gray-500">{row.event.code.agent.displayName}</div></> : "—"}</td>
                  <td className="px-5 py-4">{row.event?.lead ? <Link href={`/crm/leads/${row.event.lead.id}`} className="text-[var(--cf-text)] hover:underline">{row.event.lead.firstName} {row.event.lead.lastName}</Link> : "—"}</td>
                  <td className="px-5 py-4 font-semibold text-[var(--cf-warning)]">{money(row.event?.commissionCents ?? null)}</td>
                  <td className="px-5 py-4"><div className="flex flex-col gap-1">{row.commissionStatus ? <StatusBadge tone={row.commissionStatus === "PAYABLE" ? "green" : row.commissionStatus === "PENDING" ? "amber" : "red"}>{row.commissionStatus}</StatusBadge> : null}{row.qualityFlag ? <StatusBadge tone="red">{row.qualityFlag}</StatusBadge> : null}</div></td>
                  <td className="min-w-[240px] px-5 py-4">{row.decisionNote ?? "—"}</td>
                  <td className="px-5 py-4">{row.decidedByEmail ?? "—"}</td>
                  <td className="px-5 py-4 text-xs text-gray-500">{when(row.decidedAt)}</td>
                </tr>
              ))}
              {history.length === 0 ? <tr><td colSpan={8} className="px-5 py-10 text-center text-gray-500">No commission decisions in this period.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <ReferralClawbacks clawbacks={clawbacks} />
    </div>
  )
}
