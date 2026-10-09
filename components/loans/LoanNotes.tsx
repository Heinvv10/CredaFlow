"use client"

import { useState, useEffect, useCallback } from "react"
import { loadLoanNotes, type LoanNote as Note } from "@/lib/loan-notes"
import { SAST_TIME_ZONE } from "@/lib/utils"

const TYPE_ICONS: Record<string, string> = {
  contact: "📞",
  payment_plan: "📋",
  section129: "⚖️",
  general: "📝",
  call_answered: "📞",
  call_no_answer: "📵",
  sms: "💬",
  whatsapp: "📱",
  email: "📧",
  field_visit: "🚗",
  promise_to_pay: "✅",
  dispute: "⚠️",
  manual_payment_claim: "💰",
}

const TYPE_COLORS: Record<string, string> = {
  section129: "bg-red-50 border-red-100",
  payment_plan: "bg-blue-50 border-blue-100",
  promise_to_pay: "bg-green-50 border-green-100",
  dispute: "bg-orange-50 border-orange-100",
}

function timeAgo(date: string) {
  const diff = Date.now() - new Date(date).getTime()
  const mins = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  const days = Math.floor(diff / 86400000)
  if (mins < 60) return `${mins}m ago`
  if (hours < 24) return `${hours}h ago`
  if (days < 7) return `${days}d ago`
  return new Date(date).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric", timeZone: SAST_TIME_ZONE })
}

export function LoanNotes({ loanId }: { loanId: string }) {
  const [notes, setNotes] = useState<Note[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState("")
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    loadLoanNotes(loanId)
      .then(data => { setNotes(data); setError(null); setLoading(false) })
      .catch(() => { setError("Failed to load notes."); setLoading(false) })
  }, [loanId])

  useEffect(() => { load() }, [load])

  async function addNote(e: React.FormEvent) {
    e.preventDefault()
    if (!note.trim()) return
    setSaving(true)
    const res = await fetch(`/api/loans/${loanId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "general", note }),
    })
    setSaving(false)
    if (res.ok) {
      setNote("")
      setError(null)
      load()
    } else {
      // Keep the typed note in the textarea so it isn't lost on a rejected write.
      setError("Failed to add note. Your role may not have permission.")
    }
  }

  if (loading) return <div className="text-sm text-gray-400 p-4">Loading notes…</div>

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Add note */}
      <form onSubmit={addNote} className="flex gap-2">
        <input value={note} onChange={e => setNote(e.target.value)}
          placeholder="Add a note…"
          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[#4F46E5] focus:ring-1 focus:ring-[#4F46E5]" />
        <button type="submit" disabled={saving || !note.trim()}
          className="px-4 py-2 bg-[#4F46E5] text-white text-sm font-semibold rounded-lg hover:bg-[#4338CA] disabled:opacity-50 whitespace-nowrap">
          {saving ? "…" : "Add"}
        </button>
      </form>

      {/* Notes list */}
      {notes.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">No notes yet</p>
      ) : (
        <div className="space-y-2">
          {notes.map(n => {
            const colorClass = TYPE_COLORS[n.type] ?? "bg-gray-50 border-gray-100"
            const icon = TYPE_ICONS[n.type] ?? "📝"
            return (
              <div key={n.id} className={`flex gap-3 p-3 rounded-xl border ${colorClass}`}>
                <span className="text-base mt-0.5 flex-shrink-0">{icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-[#1b1d24] whitespace-pre-line">{n.note}</p>
                  {n.documentId && (
                    <a
                      href={`/api/documents/${n.documentId}/view`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#4F46E5] hover:text-[#4338CA] mt-1"
                    >
                      📎 View proof
                    </a>
                  )}
                  <p className="text-[11px] text-gray-400 mt-1">
                    {n.createdBy} · {timeAgo(n.createdAt)}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
