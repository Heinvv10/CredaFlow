"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"

type Kind = "INSTRUCTION" | "RESULT" | "MANDATE"

const LABELS: Record<string, string> = {
  MARK_SUBMITTED: "Provider has it: mark submitted",
  RELEASE: "Provider does not have it: release",
  ACKNOWLEDGE: "Dealt with: acknowledge",
  RETRY: "Retry submission",
}

/**
 * Resolves one collections-engine review item. A reason is required and
 * audited; the API enforces LOAN_ADMIN and that the item is still waiting.
 */
export function ReviewActions({ kind, id, actions }: { kind: Kind; id: string; actions: string[] }) {
  const router = useRouter()
  const [action, setAction] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch("/api/collections-engine/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, id, action, reason }),
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
      {error && <p className="text-sm text-[var(--cf-danger)]">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy || !reason.trim()} onClick={submit}>{busy ? "Saving…" : "Confirm"}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setAction(null)}>Back</Button>
      </div>
    </div>
  )
}
