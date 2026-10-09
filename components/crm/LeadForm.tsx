"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"

type Staff = { id: string; name: string | null; email: string }

const SOURCES = ["MANUAL", "WEBSITE", "REFERRAL", "WALK_IN", "SOCIAL", "WHATSAPP"]
const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "Manual", WEBSITE: "Website", REFERRAL: "Referral",
  WALK_IN: "Walk-in", SOCIAL: "Social Media", WHATSAPP: "WhatsApp",
}

export function LeadForm({ staff }: { staff: Staff[] }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    phone: "",
    email: "",
    source: "MANUAL",
    assignedToId: "",
    notes: "",
  })

  const [duplicates, setDuplicates] = useState<Array<{ id: string; name: string; status: string }>>([])

  const set = (field: string, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }))

  // Warn BEFORE saving, not after. The public creation paths notify the owning
  // agent once the lead exists; here the person is present, so the useful moment
  // is while they can still stop.
  //
  // Debounced because it fires on every keystroke of three fields. Never blocks
  // the form: a failed or slow check leaves `duplicates` empty and the staff
  // member saves as before — a duplicate lead is a lesser harm than a capture
  // path that stalls on a lookup.
  const { firstName: dupFirstName, lastName: dupLastName, phone: dupPhone } = form
  useEffect(() => {
    const firstName = dupFirstName
    const lastName = dupLastName
    const phone = dupPhone
    if (!firstName || !lastName || !phone) {
      setDuplicates([])
      return
    }
    const abort = new AbortController()
    const timer = setTimeout(() => {
      fetch("/api/crm/leads/check-duplicates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firstName, lastName, phone }),
        signal: abort.signal,
      })
        .then((r) => (r.ok ? r.json() : { duplicates: [] }))
        .then((d) => setDuplicates(Array.isArray(d.duplicates) ? d.duplicates : []))
        .catch(() => undefined)
    }, 400)
    return () => {
      clearTimeout(timer)
      abort.abort()
    }
  }, [dupFirstName, dupLastName, dupPhone])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.firstName || !form.lastName || !form.phone) {
      setError("First name, last name and phone are required.")
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/crm/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          email: form.email || undefined,
          assignedToId: form.assignedToId || undefined,
          notes: form.notes || undefined,
        }),
      })
      if (!res.ok) throw new Error("Failed to create lead")
      const lead = await res.json()
      router.push(`/crm/leads/${lead.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl">
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-6 space-y-5">
        <h2 className="font-semibold text-gray-900">Lead Information</h2>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {duplicates.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-md px-4 py-3 text-sm text-amber-900">
            <p className="font-semibold">
              {duplicates.length === 1
                ? "This may already be a lead you are working"
                : `This may match ${duplicates.length} leads you are already working`}
            </p>
            <ul className="mt-1.5 space-y-1">
              {duplicates.map((d) => (
                <li key={d.id}>
                  <a href={`/crm/leads/${d.id}`} target="_blank" rel="noreferrer" className="underline">
                    {d.name}
                  </a>{" "}
                  <span className="text-amber-700">({d.status})</span>
                </li>
              ))}
            </ul>
            {/* A warning, not a block: two people can share a phone, and staff
                capturing a walk-in must always be able to save. */}
            <p className="mt-1.5 text-xs text-amber-700">
              Same phone number and name. You can still save this lead.
            </p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">First Name *</label>
            <input
              type="text"
              value={form.firstName}
              onChange={(e) => set("firstName", e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
              placeholder="John"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Last Name *</label>
            <input
              type="text"
              value={form.lastName}
              onChange={(e) => set("lastName", e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
              placeholder="Doe"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Phone *</label>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
              placeholder="0821234567"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
              placeholder="john@example.com"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Lead Source</label>
            <select
              value={form.source}
              onChange={(e) => set("source", e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] bg-white"
            >
              {SOURCES.map((s) => (
                <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Assign To</label>
            <select
              value={form.assignedToId}
              onChange={(e) => set("assignedToId", e.target.value)}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] bg-white"
            >
              <option value="">Unassigned</option>
              {staff.map((s) => (
                <option key={s.id} value={s.id}>{s.name ?? s.email}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-600 mb-1.5">Notes</label>
          <textarea
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={3}
            className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
            placeholder="Any additional notes about this lead..."
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={loading}
            className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 transition-opacity"
            style={{ backgroundColor: "#4338CA" }}
          >
            {loading ? "Saving..." : "Create Lead"}
          </button>
          <button
            type="button"
            onClick={() => router.back()}
            className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </form>
  )
}
