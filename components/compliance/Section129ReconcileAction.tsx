"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export function Section129ReconcileAction({
  loanId,
  issuanceId,
  canReconcile,
}: {
  loanId: string
  issuanceId: string
  canReconcile: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [outcome, setOutcome] = useState<"ISSUED" | "NOT_SENT">("NOT_SENT")
  const [reason, setReason] = useState("")
  const [providerAcceptedAt, setProviderAcceptedAt] = useState("")
  const [providerEvidenceReference, setProviderEvidenceReference] = useState("")
  const [state, setState] = useState<"idle" | "saving" | "error" | "unknown">("idle")
  const [error, setError] = useState("")
  const providerTimestampValid = outcome !== "ISSUED" || (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(providerAcceptedAt.trim())
    && Number.isFinite(new Date(providerAcceptedAt.trim()).getTime())
  )
  const providerEvidenceReferenceValid = outcome !== "ISSUED" || (
    providerEvidenceReference.trim().length >= 3
    && providerEvidenceReference.trim().length <= 512
    && !/[\u0000-\u001F\u007F]/.test(providerEvidenceReference.trim())
  )

  if (!canReconcile) {
    return <span className="text-xs font-semibold text-amber-700">LOAN_ADMIN reconciliation required</span>
  }

  async function submit() {
    setState("saving")
    setError("")
    try {
      const response = await fetch(`/api/loans/${loanId}/section129-reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issuanceId,
          outcome,
          reason,
          ...(outcome === "ISSUED"
            ? {
                providerAcceptedAt: providerAcceptedAt.trim(),
                emailMessageId: providerEvidenceReference.trim(),
              }
            : {}),
        }),
      })
      const data = await response.json() as { ok?: boolean; error?: string }
      if (!response.ok || !data.ok) {
        setError(data.error ?? "Reconciliation failed")
        setState("error")
        return
      }
      setOpen(false)
      setState("idle")
      router.refresh()
    } catch {
      setError("Outcome unknown. Refresh this queue before submitting any reconciliation again.")
      setState("unknown")
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="rounded bg-amber-700 px-2 py-1 text-xs font-medium text-white hover:bg-amber-800">
        Reconcile
      </button>
    )
  }

  return (
    <div className="w-72 space-y-2 rounded border border-amber-300 bg-amber-50 p-2">
      <p className="break-all font-mono text-[10px] text-amber-900">Issuance {issuanceId}</p>
      <select
        value={outcome}
        onChange={(event) => setOutcome(event.target.value as "ISSUED" | "NOT_SENT")}
        className="w-full rounded border border-amber-300 bg-white px-2 py-1 text-xs"
      >
        <option value="NOT_SENT">Provider confirms NOT SENT</option>
        <option value="ISSUED">Provider confirms ISSUED</option>
      </select>
      {outcome === "ISSUED" && (
        <div className="space-y-2">
          <label className="block space-y-1 text-xs font-medium text-amber-950">
            Provider message / log reference
            <input
              type="text"
              value={providerEvidenceReference}
              onChange={(event) => setProviderEvidenceReference(event.target.value)}
              placeholder="Provider message ID or immutable log reference"
              className="w-full rounded border border-amber-300 bg-white px-2 py-1 text-xs"
            />
            <span className="block font-normal text-amber-800">Copy the identifier from the provider evidence; a reason alone cannot certify issuance.</span>
          </label>
          <label className="block space-y-1 text-xs font-medium text-amber-950">
            Provider acceptance time
            <input
              type="text"
              value={providerAcceptedAt}
              onChange={(event) => setProviderAcceptedAt(event.target.value)}
              placeholder="2026-07-19T14:32:00+02:00"
              className="w-full rounded border border-amber-300 bg-white px-2 py-1 text-xs"
            />
            <span className="block font-normal text-amber-800">Copy the provider-log ISO timestamp, including its timezone offset or Z; do not use the reconciliation time.</span>
          </label>
        </div>
      )}
      <textarea
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Provider evidence and reconciliation reason (minimum 10 characters)"
        className="min-h-20 w-full rounded border border-amber-300 bg-white p-2 text-xs"
      />
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button disabled={state === "saving" || state === "unknown" || reason.trim().length < 10 || !providerTimestampValid || !providerEvidenceReferenceValid} onClick={submit} className="rounded bg-amber-800 px-2 py-1 text-xs text-white disabled:opacity-50">
          {state === "saving" ? "Saving…" : "Confirm outcome"}
        </button>
        <button disabled={state === "saving"} onClick={() => setOpen(false)} className="text-xs text-gray-600 underline">Cancel</button>
      </div>
    </div>
  )
}
