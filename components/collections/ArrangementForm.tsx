"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

interface Props {
  loanId: string
  onCancel: () => void
}

export function ArrangementForm({ loanId, onCancel }: Props) {
  const router = useRouter()
  const [arrFreq, setArrFreq] = useState("MONTHLY")
  const [arrAmount, setArrAmount] = useState("")
  const [arrStart, setArrStart] = useState("")
  const [arrEnd, setArrEnd] = useState("")
  const [arrNotes, setArrNotes] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!arrAmount || !arrStart || !arrEnd) { setError("Fill all required fields"); return }
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/loans/${loanId}/payment-arrangement`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          arrangementDate: new Date().toISOString(),
          agreedAmount: Math.round(parseFloat(arrAmount) * 100),
          frequency: arrFreq,
          startDate: arrStart,
          endDate: arrEnd,
          notes: arrNotes || undefined,
        }),
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
    <div className="border border-green-200 rounded-lg p-4 bg-green-50 space-y-3">
      <p className="text-sm font-semibold text-green-800">Payment Arrangement</p>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-[11px] font-medium text-gray-600 block mb-1">Agreed Amount (R) *</label>
          <input type="number" value={arrAmount} onChange={e => setArrAmount(e.target.value)}
            className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400" placeholder="e.g. 1500" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-600 block mb-1">Frequency *</label>
          <select value={arrFreq} onChange={e => setArrFreq(e.target.value)}
            className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400">
            <option value="WEEKLY">Weekly</option>
            <option value="BIWEEKLY">Bi-weekly</option>
            <option value="MONTHLY">Monthly</option>
          </select>
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-600 block mb-1">Start Date *</label>
          <input type="date" value={arrStart} onChange={e => setArrStart(e.target.value)}
            className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-600 block mb-1">End Date *</label>
          <input type="date" value={arrEnd} onChange={e => setArrEnd(e.target.value)}
            className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-400" />
        </div>
      </div>
      <textarea value={arrNotes} onChange={e => setArrNotes(e.target.value)}
        placeholder="Notes (optional)" rows={2}
        className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-green-400" />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={loading}
          className="flex-1 py-2 rounded text-white text-sm font-medium disabled:opacity-50"
          style={{ backgroundColor: "#10B981" }}>
          {loading ? "Saving…" : "Save Arrangement"}
        </button>
        <button onClick={onCancel}
          className="px-4 py-2 rounded border border-gray-200 text-gray-600 text-sm hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  )
}
