"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { formatDate } from "@/lib/utils"
import { Plus, X } from "lucide-react"

type FaisRecord = {
  id: string
  completedAt: string | null
  createdAt: string
  data: {
    notes?: string | null
    loggedByName?: string | null
    loggedById?: string | null
  } | null
}

async function fetchFaisRecords(clientId: string): Promise<FaisRecord[]> {
  const res = await fetch(`/api/clients/${clientId}/fais-disclosures`)
  if (!res.ok) throw new Error("Failed to load")
  return await res.json() as FaisRecord[]
}

export function FaisDisclosuresSection({ clientId }: { clientId: string }) {
  const router = useRouter()
  const [records, setRecords] = useState<FaisRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [form, setForm] = useState({ notes: "", date: new Date().toISOString().slice(0, 10) })
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  // Bumped to refetch after a disclosure is logged.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let ignore = false
    fetchFaisRecords(clientId)
      .then((data) => { if (!ignore) setRecords(data) })
      .catch(() => { if (!ignore) setError("Failed to load FAIS disclosures.") })
      .finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [clientId, reloadKey])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/fais-disclosures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notes: form.notes || undefined, date: form.date }),
      })
      if (!res.ok) throw new Error("Failed to log disclosure")
      setShowModal(false)
      setForm({ notes: "", date: new Date().toISOString().slice(0, 10) })
      setLoading(true)
      setReloadKey((k) => k + 1)
      router.refresh()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-gray-900">FAIS Disclosures</h3>
        <button
          onClick={() => { setShowModal(true); setFormError(null) }}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA] transition-colors"
        >
          <Plus className="h-4 w-4" /> Log Disclosure
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700 mb-4">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-400 py-4 text-center">Loading...</p>
      ) : records.length === 0 ? (
        <p className="text-sm text-gray-400 py-4 text-center">No FAIS disclosures logged yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              <th className="px-4 py-3 text-left">Date</th>
              <th className="px-4 py-3 text-left">Logged By</th>
              <th className="px-4 py-3 text-left">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {records.map((r) => {
              const data = r.data as { notes?: string | null; loggedByName?: string | null } | null
              return (
                <tr key={r.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700 whitespace-nowrap">
                    {r.completedAt ? formatDate(r.completedAt) : formatDate(r.createdAt)}
                  </td>
                  <td className="px-4 py-3 text-gray-700">
                    {data?.loggedByName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-gray-500">
                    {data?.notes ?? <span className="text-gray-300">—</span>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900">Log FAIS Disclosure</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleSubmit} className="p-6 space-y-4">
              {formError && (
                <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
                  {formError}
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Disclosure Date *</label>
                <input
                  type="date"
                  value={form.date}
                  onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                  required
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={4}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
                  placeholder="Details of the FAIS disclosure made to the client..."
                />
              </div>
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 transition-opacity"
                  style={{ backgroundColor: "#4338CA" }}
                >
                  {submitting ? "Saving..." : "Log Disclosure"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
