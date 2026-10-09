"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

interface Props {
  loanId: string
  onCancel: () => void
}

export function WriteOffForm({ loanId, onCancel }: Props) {
  const router = useRouter()
  const [woReason, setWoReason] = useState("")
  const [woConfirm, setWoConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!woReason.trim()) { setError("Reason required"); return }
    if (!woConfirm) { setError("Confirmation required"); return }
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/loans/${loanId}/write-off`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "request", reason: woReason }),
      })
      if (!res.ok) { const d = await res.json() as { error?: string }; setError(d.error ?? "Failed"); return }
      router.refresh()
      onCancel()
    } catch {
      setError("Request failed")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="border border-red-200 rounded-lg p-4 bg-red-50 space-y-3">
      <p className="text-sm font-semibold text-red-800">⚠️ Request Write-Off</p>
      <p className="text-xs text-red-600">This submits a write-off request for approval by a second officer. The loan moves to Pending Write-Off until approved.</p>
      <textarea value={woReason} onChange={e => setWoReason(e.target.value)}
        placeholder="Reason for write-off *" rows={3}
        className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-red-400" />
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={woConfirm} onChange={e => setWoConfirm(e.target.checked)} className="w-4 h-4" />
        <span className="text-xs text-red-700 font-medium">I confirm this account should be written off</span>
      </label>
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={loading || !woConfirm || !woReason.trim()}
          className="flex-1 py-2 rounded text-white text-sm font-medium disabled:opacity-50 bg-red-600">
          {loading ? "Processing…" : "Submit Write-Off Request"}
        </button>
        <button onClick={onCancel}
          className="px-4 py-2 rounded border border-gray-200 text-gray-600 text-sm hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  )
}
