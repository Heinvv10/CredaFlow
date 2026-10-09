"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"

type RegisteredFirm = { id: string; name: string; contactPerson: string | null; phone: string | null; email: string | null }

interface Props {
  loanId: string
  onCancel: () => void
}

export function AttorneyReferralForm({ loanId, onCancel }: Props) {
  const router = useRouter()
  const [registeredFirms, setRegisteredFirms] = useState<RegisteredFirm[]>([])
  const [refFirmId, setRefFirmId] = useState<string | null>(null)
  const [refFirm, setRefFirm] = useState("")
  const [refContact, setRefContact] = useState("")
  const [refPhone, setRefPhone] = useState("")
  const [refEmail, setRefEmail] = useState("")
  const [refMatter, setRefMatter] = useState("")
  const [refNotes, setRefNotes] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/settings/attorneys", { credentials: "include" })
      .then(r => r.json())
      .then((d: RegisteredFirm[]) => setRegisteredFirms(Array.isArray(d) ? d : []))
      .catch(() => { /* firms list is optional — form still works without pre-fill */ })
  }, [])

  async function submit() {
    if (!refFirm) { setError("Attorney firm name required"); return }
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/loans/${loanId}/attorney-referral`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          firmId: refFirmId || undefined,
          firmName: refFirm,
          contactPerson: refContact || undefined,
          contactPhone: refPhone || undefined,
          contactEmail: refEmail || undefined,
          referralDate: new Date().toISOString(),
          matterNumber: refMatter || undefined,
          notes: refNotes || undefined,
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
    <div className="border border-purple-200 rounded-lg p-4 bg-purple-50 space-y-3">
      <p className="text-sm font-semibold text-purple-800">Attorney Referral</p>
      <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
        Pre-enforcement legal review only. This action does not confirm Section 129 delivery or authorise court enforcement; applicable NCA section 130 prerequisites must be verified separately.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="text-[11px] font-medium text-gray-600 block mb-1">Attorney Firm *</label>
          {registeredFirms.length > 0 && (
            <select
              value={refFirmId ?? ""}
              onChange={e => {
                const firm = registeredFirms.find(f => f.id === e.target.value)
                setRefFirmId(e.target.value || null)
                if (firm) {
                  setRefFirm(firm.name); setRefContact(firm.contactPerson ?? "")
                  setRefPhone(firm.phone ?? ""); setRefEmail(firm.email ?? "")
                } else {
                  setRefFirm(""); setRefContact(""); setRefPhone(""); setRefEmail("")
                }
              }}
              className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400 bg-white"
            >
              <option value="">— select from register or type below —</option>
              {registeredFirms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
          <input value={refFirm} onChange={e => setRefFirm(e.target.value)}
            className={`w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400 ${registeredFirms.length > 0 ? "mt-1.5" : ""}`}
            placeholder={registeredFirms.length > 0 ? "Or type firm name manually" : "e.g. Smith & Associates"} />
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-600 block mb-1">Contact Person</label>
          <input value={refContact} onChange={e => setRefContact(e.target.value)}
            className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400" placeholder="Name" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-600 block mb-1">Phone</label>
          <input value={refPhone} onChange={e => setRefPhone(e.target.value)}
            className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400" placeholder="+27..." />
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-600 block mb-1">Email</label>
          <input value={refEmail} onChange={e => setRefEmail(e.target.value)}
            className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400" placeholder="attorney@example.com" />
        </div>
        <div>
          <label className="text-[11px] font-medium text-gray-600 block mb-1">Matter Number</label>
          <input value={refMatter} onChange={e => setRefMatter(e.target.value)}
            className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-purple-400" placeholder="e.g. 2026-001" />
        </div>
      </div>
      <textarea value={refNotes} onChange={e => setRefNotes(e.target.value)}
        placeholder="Notes (optional)" rows={2}
        className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-purple-400" />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={loading}
          className="flex-1 py-2 rounded text-white text-sm font-medium disabled:opacity-50"
          style={{ backgroundColor: "#8B5CF6" }}>
          {loading ? "Saving…" : "Refer to Attorney"}
        </button>
        <button onClick={onCancel}
          className="px-4 py-2 rounded border border-gray-200 text-gray-600 text-sm hover:bg-gray-50">
          Cancel
        </button>
      </div>
    </div>
  )
}
