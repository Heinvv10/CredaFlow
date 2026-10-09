"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { X, Calendar } from "lucide-react"
import { SAST_TIME_ZONE } from "@/lib/utils"

interface Props {
  leadId: string
  onClose: () => void
}

export function CallbackModal({ leadId, onClose }: Props) {
  const router = useRouter()
  const [date, setDate] = useState("")
  const [time, setTime] = useState("09:00")
  const [notes, setNotes] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!date) return
    setLoading(true)
    setError(null)

    const callbackDate = new Date(`${date}T${time}:00`)
    const res = await fetch(`/api/crm/leads/${leadId}/callback`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callbackDate: callbackDate.toISOString(), callbackNotes: notes }),
    })

    setLoading(false)
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      setError((data as { error?: string }).error ?? "Failed to schedule callback")
      return
    }
    router.refresh()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-[#4338CA]" />
            <h2 className="font-semibold text-gray-900 text-sm">Schedule Callback</h2>
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Date</label>
              <input
                type="date"
                value={date}
                // SAST calendar day, not UTC — toISOString() lets "today" read
                // as yesterday between 00:00–01:59 SAST.
                min={new Date().toLocaleDateString("en-CA", { timeZone: SAST_TIME_ZONE })}
                onChange={(e) => setDate(e.target.value)}
                required
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4338CA]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Time</label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4338CA]"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="What to discuss, client context..."
              rows={3}
              className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#4338CA] resize-none"
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
              disabled={loading || !date}
              className="flex-1 px-4 py-2 text-sm rounded-md text-white font-medium disabled:opacity-50"
              style={{ backgroundColor: "#4338CA" }}
            >
              {loading ? "Saving…" : "Schedule"}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
