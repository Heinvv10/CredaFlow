"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

export function Section129RecoveryAction({
  loanId,
  issuanceId,
  lifecycle,
}: {
  loanId: string
  issuanceId: string
  lifecycle: string
}) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  async function recover() {
    setSaving(true)
    setError("")
    try {
      const response = await fetch(`/api/loans/${loanId}/section129-recover`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issuanceId }),
      })
      const data = await response.json() as { ok?: boolean; error?: string }
      if (!response.ok || !data.ok) {
        setError(data.error ?? "Recovery failed")
        return
      }
      setConfirming(false)
      router.refresh()
    } catch {
      setError("Recovery outcome unknown. Refresh before taking another action.")
    } finally {
      setSaving(false)
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="rounded bg-amber-700 px-2 py-1 text-xs font-medium text-white hover:bg-amber-800"
      >
        Recover timed-out issuance
      </button>
    )
  }

  return (
    <div className="w-72 space-y-2 rounded border border-amber-300 bg-amber-50 p-2">
      <p className="text-xs font-semibold text-amber-950">Timed-out {lifecycle.toLowerCase()} issuance</p>
      <p className="text-[11px] text-amber-900">
        Recovery will delete and release an unsent staged artifact, or lock a possibly dispatched notice for provider reconciliation.
      </p>
      <p className="break-all font-mono text-[10px] text-amber-800">{issuanceId}</p>
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={recover}
          className="rounded bg-amber-800 px-2 py-1 text-xs text-white disabled:opacity-50"
        >
          {saving ? "Recovering…" : "Confirm recovery"}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => setConfirming(false)}
          className="text-xs text-gray-600 underline"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
