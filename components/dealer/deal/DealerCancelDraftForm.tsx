"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"

const MIN_REASON = 10

/**
 * Cancels a draft the lender has not received (POST …/cancel, with a reason).
 * Shown to the dealer admin and to the user who captured the draft; the
 * server applies the same rule.
 */
export function DealerCancelDraftForm({ dealId }: { dealId: string }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function cancel() {
    if (reason.trim().length < MIN_REASON) return setError(`Say why the draft is cancelled (at least ${MIN_REASON} characters)`)
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/dealer/deals/${dealId}/cancel`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: reason.trim() }),
      })
      const body = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) return setError(body.error ?? `The draft could not be cancelled (${res.status})`)
      router.refresh()
    } catch {
      setError("Network error. Try again.")
    } finally {
      setSaving(false)
    }
  }

  if (!open) return <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Cancel draft</Button>
  return (
    <div className="space-y-2 rounded-md border border-[var(--cf-border-subtle)] p-3">
      <label htmlFor="cancel-reason" className="block text-xs font-semibold text-[var(--cf-text-secondary)]">Why is this draft cancelled?</label>
      <Textarea id="cancel-reason" rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="text-xs text-[var(--cf-text-muted)]">Don&apos;t type ID numbers or other personal details.</p>
      <p className="text-xs text-[var(--cf-text-muted)]">
        The lender keeps this draft&apos;s details for 90 days after you cancel it. It then erases the people, business and documents you
        captured on it, unless it holds them for another reason.
      </p>
      {error ? <p role="alert" className="text-xs text-[var(--cf-danger)]">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="sm" variant="destructive" onClick={cancel} disabled={saving}>{saving ? "Cancelling…" : "Cancel the draft"}</Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Keep it</Button>
      </div>
    </div>
  )
}
