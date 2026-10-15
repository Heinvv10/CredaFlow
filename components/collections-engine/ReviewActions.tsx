"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

type Kind = "INSTRUCTION" | "RESULT" | "MANDATE"

const LABELS: Record<string, string> = {
  MARK_SUBMITTED: "Provider has it: mark submitted",
  RELEASE: "Provider does not have it: release",
  ACKNOWLEDGE: "Dealt with / confirmed with the provider: acknowledge",
  RETRY: "Retry submission",
}

/**
 * Resolves one collections-engine review item. A reason is required and
 * audited; the API enforces LOAN_ADMIN and that the item is still waiting.
 */
export function ReviewActions({ kind, id, actions, unbookedPayment = false }: {
  kind: Kind
  id: string
  actions: string[]
  /** A PAID result that was never booked: acknowledging names the receipt captured for it, or "no money received". */
  unbookedPayment?: boolean
}) {
  const router = useRouter()
  const [action, setAction] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  // RELEASE re-opens a debit for sending: staff must say they confirmed the provider never received it.
  const [confirmedNotSent, setConfirmedNotSent] = useState(false)
  const [paymentId, setPaymentId] = useState("")
  const [noMoneyReceived, setNoMoneyReceived] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/collections-engine/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, id, action, reason, confirmedNotSent, paymentId: paymentId.trim() || undefined, noMoneyReceived }),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({})) as { error?: string }
        setError(json.error ?? `Request failed (${response.status})`)
        return
      }
      setAction(null)
      setReason("")
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed")
    } finally {
      setBusy(false)
    }
  }

  if (!action) {
    return (
      <div className="mt-2 flex flex-wrap gap-2">
        {actions.map((a) => (
          <Button key={a} type="button" variant="outline" size="sm" onClick={() => setAction(a)}>{LABELS[a] ?? a}</Button>
        ))}
      </div>
    )
  }
  return (
    <div className="mt-2 space-y-2">
      <label htmlFor={`review-${id}`} className="block text-xs font-medium text-[var(--cf-text-muted)]">
        {LABELS[action] ?? action}: reason (required, recorded in the audit trail)
      </label>
      <textarea id={`review-${id}`} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)}
        className="w-full rounded border border-[var(--cf-border-subtle)] bg-transparent p-2 text-sm text-[var(--cf-text)]" />
      {action === "RELEASE" && (
        <label className="flex items-center gap-2 text-xs text-[var(--cf-text)]">
          <input type="checkbox" checked={confirmedNotSent} onChange={(e) => setConfirmedNotSent(e.target.checked)} />
          I confirmed with the provider that it was not received
        </label>
      )}
      {unbookedPayment && (
        <div className="space-y-1 text-xs text-[var(--cf-text)]">
          <input value={paymentId} onChange={(e) => setPaymentId(e.target.value)} placeholder="Receipt ID captured for this money"
            className="w-full rounded border border-[var(--cf-border-subtle)] bg-transparent p-2 text-sm" disabled={noMoneyReceived} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={noMoneyReceived} onChange={(e) => setNoMoneyReceived(e.target.checked)} />
            No money was received
          </label>
        </div>
      )}
      {error && <p className="text-sm text-[var(--cf-danger)]">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || !reason.trim() || (action === "RELEASE" && !confirmedNotSent) || (unbookedPayment && !paymentId.trim() && !noMoneyReceived)} onClick={submit}>{busy ? "Saving…" : "Confirm"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setAction(null)}>Back</Button>
      </div>
    </div>
  )
}
