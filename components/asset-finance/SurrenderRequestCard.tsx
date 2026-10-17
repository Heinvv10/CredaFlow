"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

interface Props {
  loanId: string
  existing: { id: string; status: string } | null
  /** False once the lender holds the asset (a live recovery): no new request, an existing one still shows its status. */
  canRequest?: boolean
}

export function SurrenderRequestCard({ loanId, existing, canRequest = true }: Props) {
  const router = useRouter()
  const [condition, setCondition] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/portal/asset-finance/loans/${loanId}/surrender`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetCondition: condition }),
      })
      if (!response.ok) {
        const body = await response.json() as { error?: string }
        setError(body.error ?? "The surrender request could not be recorded")
        return
      }
      router.refresh()
    } catch {
      setError("The surrender request could not be sent")
    } finally {
      setBusy(false)
    }
  }

  if (existing && existing.status !== "WITHDRAWN") {
    return (
      <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4 text-sm">
        <p className="font-semibold text-[var(--cf-text)]">Voluntary surrender recorded</p>
        <p className="mt-1 text-[var(--cf-text-muted)]">Status: {existing.status.replaceAll("_", " ").toLowerCase()}</p>
        <div className="mt-3 flex gap-3">
          <a className="text-[var(--cf-brand)] underline" href={`/api/portal/asset-finance/surrenders/${existing.id}/documents/valuation`} target="_blank" rel="noreferrer">Valuation notice</a>
          <a className="text-[var(--cf-brand)] underline" href={`/api/portal/asset-finance/surrenders/${existing.id}/documents/final`} target="_blank" rel="noreferrer">Final notice</a>
        </div>
      </div>
    )
  }

  if (!canRequest) return null

  return (
    <div className="rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-raised)] p-4">
      {existing?.status === "WITHDRAWN" && <p className="mb-2 text-sm">The previous surrender was withdrawn and the goods returned.</p>}
      <p className="font-semibold text-[var(--cf-text)]">Voluntary surrender (NCA s127)</p>
      <p className="mt-1 text-xs text-[var(--cf-text-muted)]">Describe the asset condition. This records a formal request; staff will arrange valuation and issue the draft notices.</p>
      <textarea value={condition} onChange={(event) => setCondition(event.target.value)} rows={3} maxLength={2000}
        className="mt-3 w-full rounded-md border border-[var(--cf-border-strong)] bg-[var(--cf-bg)] p-2 text-sm text-[var(--cf-text)]" />
      <button type="button" onClick={submit} disabled={busy || condition.trim().length < 3}
        className="mt-2 rounded-md bg-[var(--cf-brand)] px-4 py-2 text-sm font-semibold text-[var(--cf-on-brand)] disabled:opacity-50">
        {busy ? "Recording…" : "Request voluntary surrender"}
      </button>
      {error && <p className="mt-2 text-xs text-[var(--cf-danger)]">{error}</p>}
    </div>
  )
}
