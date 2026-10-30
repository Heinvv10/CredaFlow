"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export interface MonthChoice {
  periodKey: string
  /** The month's current run, or null when it has none (the form adds a late run; otherwise it replaces this one). */
  currentRunId: string | null
}

async function post(url: string, body: unknown): Promise<string | null> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (res.ok) return null
  const json = (await res.json().catch(() => ({}))) as { error?: string }
  return json.error ?? `The request failed (${res.status})`
}

/** Analysis run, and the late / superseding monthly run (admin, second factor when the lender requires one). The server authorizes every write. */
export function Ifrs9RunActions({ months, canRun }: { months: MonthChoice[]; canRun: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null)
  const [periodKey, setPeriodKey] = useState(months[0]?.periodKey ?? "")
  const [reason, setReason] = useState("")
  const month = months.find((m) => m.periodKey === periodKey)

  async function run(url: string, body: unknown, done: string) {
    setBusy(true)
    setMessage(null)
    const error = await post(url, body)
    setBusy(false)
    if (error) return setMessage({ tone: "error", text: error })
    setMessage({ tone: "ok", text: done })
    router.refresh()
  }

  if (!canRun) return <p className="text-sm text-[var(--cf-text-muted)]">Running IFRS 9 needs an administrator.</p>
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => run("/api/ifrs9/runs", { kind: "ON_DEMAND" }, "Analysis run made. It describes today and never reaches the ledger.")}>
          Run analysis now
        </Button>
      </div>
      {months.length > 0 && (
        <form
          className="space-y-2 rounded-lg border border-[var(--cf-border-subtle)] p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!month) return
            const body = { periodKey: month.periodKey, reason, ...(month.currentRunId ? { supersedesRunId: month.currentRunId } : {}) }
            void run("/api/ifrs9/runs/monthly", body, month.currentRunId ? "The month's run was replaced." : "The late run was added.")
          }}
        >
          <p className="text-sm font-medium text-[var(--cf-text)]">Month-end run for an ended, open month</p>
          <p className="text-xs text-[var(--cf-text-muted)]">
            Adds the run the month-end job missed, or replaces the month&apos;s current run. It is rebuilt as at the month&apos;s last day and the replaced run stays on record.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-[var(--cf-text-muted)]">
              Month
              <select aria-label="Month" className="mt-1 block rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] px-2 py-2 text-sm text-[var(--cf-text)]" value={periodKey} onChange={(e) => setPeriodKey(e.target.value)}>
                {months.map((m) => <option key={m.periodKey} value={m.periodKey}>{m.periodKey}{m.currentRunId ? " (replace its run)" : " (no run yet)"}</option>)}
              </select>
            </label>
            <Input aria-label="Reason" className="min-w-64 flex-1" placeholder="Reason (required, kept on record)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            <Button size="sm" type="submit" disabled={busy || reason.trim().length < 5}>{month?.currentRunId ? "Replace run" : "Add late run"}</Button>
          </div>
        </form>
      )}
      {message && <p role="status" className={message.tone === "error" ? "text-sm text-[var(--cf-danger)]" : "text-sm text-[var(--cf-success)]"}>{message.text}</p>}
    </div>
  )
}
