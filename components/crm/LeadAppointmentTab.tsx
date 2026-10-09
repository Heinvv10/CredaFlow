"use client"

import { useState } from "react"
import { CalendarClock, Loader2 } from "lucide-react"
import { SAST_TIME_ZONE } from "@/lib/utils"

// Client component: prisma-free imports only. The modal's "Appointment" tab —
// callback scheduling against the existing PATCH /api/crm/leads/[id]/callback
// route (the same one CallbackModal uses), shown inline GHL-style.

const pad = (n: number) => String(n).padStart(2, "0")

// State is seeded from props at mount, so the PARENT MUST key this component
// by lead id — a remount is what guarantees lead B never sees lead A's draft.
export function LeadAppointmentTab({
  leadId,
  status,
  callbackDate,
  callbackNotes,
  onChanged,
}: {
  leadId: string
  status: string
  callbackDate: string | null
  callbackNotes: string | null
  onChanged: () => void
}) {
  const current = callbackDate ? new Date(callbackDate) : null
  // Prefill a FUTURE callback for rescheduling, in browser-local parts so the
  // round-trip through `new Date(`${date}T${time}:00`)` (browser-local, same
  // semantics as CallbackModal) reproduces the stored instant exactly. An
  // overdue date stays empty — prefilled it would just sit invalid under the
  // input's min=today.
  const isFuture = current !== null && current > new Date()
  // sast-pending: a `useState` initialiser runs during SSR too, in the
  // container's UTC zone, so for two hours a day the first HTML painted
  // here differs from what the browser recomputes on hydration. The value
  // is deliberately browser-local — it round-trips back through local
  // parsing — so the fix is to seed it client-side or suppress the
  // mismatch, NOT to convert it to SAST. That is a hydration change, not
  // a boundary change, and does not belong in this pass.
  const [date, setDate] = useState(isFuture && current ? `${current.getFullYear()}-${pad(current.getMonth() + 1)}-${pad(current.getDate())}` : "")
  // sast-pending: as above.
  const [time, setTime] = useState(isFuture && current ? `${pad(current.getHours())}:${pad(current.getMinutes())}` : "09:00")
  const [notes, setNotes] = useState(callbackNotes ?? "")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Same bar as the full page's "Schedule Callback" button: the callback
  // route moves the lead to CONTACTED, which must never pull back a
  // CONVERTED/LOST record.
  if (status === "CONVERTED" || status === "LOST") {
    return (
      <p className="py-8 text-center text-sm text-gray-500">
        Callbacks are not available for closed leads.
      </p>
    )
  }

  const handleSchedule = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!date || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/crm/leads/${leadId}/callback`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callbackDate: new Date(`${date}T${time}:00`).toISOString(),
          callbackNotes: notes,
        }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? "Failed to schedule callback")
        return
      }
      onChanged()
    } catch {
      setError("Failed to schedule callback")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-lg border border-gray-200 p-3">
        <CalendarClock className="mt-0.5 h-4 w-4 flex-none text-amber-600" />
        <div className="min-w-0 text-sm">
          {current ? (
            <>
              <p className={`font-medium ${current < new Date() ? "text-red-600" : "text-gray-900"}`}>
                {current < new Date() ? "Overdue: " : "Scheduled: "}
                {current.toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}
              </p>
              {callbackNotes && <p className="mt-1 whitespace-pre-wrap text-gray-600">{callbackNotes}</p>}
            </>
          ) : (
            <p className="text-gray-500">No callback scheduled yet.</p>
          )}
        </div>
      </div>

      <form onSubmit={handleSchedule} className="space-y-3 rounded-lg border border-gray-200 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          {current ? "Reschedule" : "Schedule a callback"}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-medium text-gray-600">
            Date
            {/* SAST calendar day, not UTC — toISOString() would let "today"
                read as yesterday between 00:00–01:59 SAST. en-CA gives
                YYYY-MM-DD, the format a date input expects. */}
            <input type="date" value={date} min={new Date().toLocaleDateString("en-CA", { timeZone: SAST_TIME_ZONE })} required onChange={(e) => setDate(e.target.value)} className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500" />
          </label>
          <label className="block text-xs font-medium text-gray-600">
            Time
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="mt-1 w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500" />
          </label>
        </div>
        <label className="block text-xs font-medium text-gray-600">
          Notes (optional)
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="What to discuss, client context…" className="mt-1 w-full resize-y rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500" />
        </label>
        <div className="flex items-center justify-end gap-2">
          {error && <span className="text-xs text-red-600">{error}</span>}
          <button type="submit" disabled={!date || saving} className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50">
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {current ? "Reschedule" : "Schedule"}
          </button>
        </div>
      </form>

      <p className="text-xs text-gray-500">
        Scheduling a callback marks the lead as Contacted.
      </p>
    </div>
  )
}
