"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { addLeadActivity } from "@/app/actions/crm"
import { ActivityRow } from "@/components/crm/LeadTimelineRow"

// Client component: prisma-free imports only; addLeadActivity is a server
// action stub (session-gated, tenant-scoped, audited server-side).

type NoteActivity = { id: string; type: string; subject: string; notes: string | null; createdAt: string }

/**
 * GHL-style Notes tab for the lead modal: search + add-note composer + the
 * NOTE-type activities, newest first. Notes are CrmActivity rows (the same
 * ones the Activity timeline shows) — this tab is a filtered view plus a
 * quicker composer, not a second store.
 */
export function LeadNotesTab({
  leadId,
  activities,
  onChanged,
}: {
  leadId: string
  activities: NoteActivity[]
  onChanged: () => void
}) {
  const [body, setBody] = useState("")
  const [query, setQuery] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const notes = activities.filter((a) => a.type === "NOTE")
  const q = query.trim().toLowerCase()
  const visible = q
    ? notes.filter((n) => n.subject.toLowerCase().includes(q) || (n.notes ?? "").toLowerCase().includes(q))
    : notes

  const handleAdd = async () => {
    const text = body.trim()
    if (!text || saving) return
    setSaving(true)
    setError(null)
    try {
      // First line becomes the subject the timeline shows; the full text is
      // kept in notes so nothing is lost when the note is multi-line.
      const firstLine = text.split("\n")[0].replace(/\r$/, "")
      const result = await addLeadActivity({
        leadId,
        type: "NOTE",
        subject: firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine,
        notes: text,
      })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setBody("")
      onChanged()
    } catch {
      // A throw here is the masked-digest path (session gone, network) — show
      // something actionable rather than the digest.
      setError("Could not add the note. Reload and try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-gray-200 p-3">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a note…"
          className="h-20 w-full resize-y rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          {error && <span className="text-xs text-red-600">{error}</span>}
          <button
            onClick={handleAdd}
            disabled={!body.trim() || saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Add note
          </button>
        </div>
      </div>

      {notes.length > 3 && (
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search notes…"
          className="w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500"
        />
      )}

      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-gray-500">
          {notes.length === 0 ? "No notes yet." : "No notes match your search."}
        </p>
      ) : (
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {visible.map((n) => (
            <ActivityRow key={n.id} entry={{ kind: "activity", id: n.id, type: n.type, subject: n.subject, notes: n.notes, createdAt: new Date(n.createdAt) }} />
          ))}
        </div>
      )}
    </div>
  )
}
