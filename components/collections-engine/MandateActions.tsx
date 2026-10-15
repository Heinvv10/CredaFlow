"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

const field = "w-full rounded border border-[var(--cf-border-subtle)] bg-transparent p-2 text-sm text-[var(--cf-text)]"
const label = "block text-xs font-medium text-[var(--cf-text-muted)]"

async function post(url: string, body: unknown): Promise<string | null> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  if (response.ok) return null
  const json = await response.json().catch(() => ({})) as { error?: string }
  return json.error ?? `Request failed (${response.status})`
}

/**
 * Sets up a DebiCheck mandate. The recommended debit day and tracking days
 * (strike-date analysis) are prefilled; the API re-validates every scheme
 * limit, so these controls are affordances only.
 */
export function MandateSetupForm({ loanId, debitDay, trackingDays }: { loanId: string; debitDay: number | null; trackingDays: number | null }) {
  const router = useRouter()
  const [form, setForm] = useState({ authType: "TT1", debitDay: String(debitDay ?? ""), trackingDays: String(trackingDays ?? 3) })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const failure = await post(`/api/loans/${loanId}/collections-mandate`, {
        authType: form.authType, debitDay: Number(form.debitDay), trackingDays: Number(form.trackingDays),
      })
      if (failure) setError(failure)
      else router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label htmlFor={`mandate-auth-${loanId}`} className={label}>Authentication</label>
          <select id={`mandate-auth-${loanId}`} className={field} value={form.authType} onChange={(e) => setForm((f) => ({ ...f, authType: e.target.value }))}>
            <option value="TT1">TT1 (real time)</option>
            <option value="TT1_DELAYED">TT1 delayed</option>
            <option value="TT2">TT2 (batch)</option>
          </select>
        </div>
        <div>
          <label htmlFor={`mandate-day-${loanId}`} className={label}>Debit day</label>
          <input id={`mandate-day-${loanId}`} className={field} type="number" min={1} max={31} value={form.debitDay} onChange={(e) => setForm((f) => ({ ...f, debitDay: e.target.value }))} />
        </div>
        <div>
          <label htmlFor={`mandate-tracking-${loanId}`} className={label}>Tracking days</label>
          <input id={`mandate-tracking-${loanId}`} className={field} type="number" min={1} max={10} value={form.trackingDays} onChange={(e) => setForm((f) => ({ ...f, trackingDays: e.target.value }))} />
        </div>
      </div>
      {error && <p className="text-sm text-[var(--cf-danger)]">{error}</p>}
      <Button type="button" size="sm" disabled={busy || !form.debitDay} onClick={submit}>
        {busy ? "Sending…" : "Send mandate for authorisation"}
      </Button>
    </div>
  )
}

/** Cancels a mandate with the provider and here. A reason is required and audited. */
export function MandateCancelButton({ loanId, mandateId }: { loanId: string; mandateId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const failure = await post(`/api/loans/${loanId}/collections-mandate/${mandateId}/cancel`, { reason })
      if (failure) setError(failure)
      else {
        setOpen(false)
        router.refresh()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed")
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>Cancel mandate</Button>
  }
  return (
    <div className="space-y-2">
      <label htmlFor={`mandate-cancel-${mandateId}`} className={label}>Reason (required, recorded in the audit trail)</label>
      <textarea id={`mandate-cancel-${mandateId}`} className={field} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && <p className="text-sm text-[var(--cf-danger)]">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" disabled={busy || !reason.trim()} onClick={submit}>
          {busy ? "Cancelling…" : "Confirm cancellation"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Back</Button>
      </div>
    </div>
  )
}
