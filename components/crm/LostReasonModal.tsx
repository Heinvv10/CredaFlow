"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { X, XCircle } from "lucide-react"

interface Props {
  leadId: string
  onClose: () => void
}

const LOST_REASONS = [
  { value: "TOO_EXPENSIVE", label: "Too Expensive", desc: "Rate or fee too high" },
  { value: "WENT_ELSEWHERE", label: "Went Elsewhere", desc: "Chose a competitor" },
  { value: "NOT_QUALIFIED", label: "Not Qualified", desc: "Failed affordability check" },
  { value: "NO_RESPONSE", label: "No Response", desc: "Stopped responding to contact" },
  { value: "PRODUCT_MISMATCH", label: "Product Mismatch", desc: "Needs don't match our offering" },
] as const

type LostReason = typeof LOST_REASONS[number]["value"]

export function LostReasonModal({ leadId, onClose }: Props) {
  const router = useRouter()
  const [selected, setSelected] = useState<LostReason | null>(null)
  const [notes, setNotes] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selected) return
    setLoading(true)
    setError(null)

    const res = await fetch(`/api/crm/leads/${leadId}/lost`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: selected, notes }),
    })

    setLoading(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError((data as { error?: string }).error ?? "Failed to update lead")
      return
    }
    router.refresh()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-500" />
            <h2 className="font-semibold text-gray-900 text-sm">Mark Lead as Lost</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          <p className="text-xs text-gray-500">Select the primary reason this lead was lost. This data improves future conversion rates.</p>
          <div className="space-y-2">
            {LOST_REASONS.map((r) => (
              <button
                key={r.value}
                type="button"
                onClick={() => setSelected(r.value)}
                className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all text-sm ${
                  selected === r.value
                    ? "border-red-300 bg-red-50"
                    : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                <span className="font-medium text-gray-800">{r.label}</span>
                <span className="block text-[11px] text-gray-400 mt-0.5">{r.desc}</span>
              </button>
            ))}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Additional notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-red-400 resize-none"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 text-sm border border-gray-200 rounded-md text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !selected}
              className="flex-1 px-4 py-2 text-sm rounded-md text-white font-medium bg-red-500 hover:bg-red-600 disabled:opacity-50"
            >
              {loading ? "Saving…" : "Mark as Lost"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
