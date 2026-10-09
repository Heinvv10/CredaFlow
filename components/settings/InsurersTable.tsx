"use client"

import { useState, useEffect } from "react"
import { toast } from "@/lib/toast"
import { Button } from "@/components/ui/button"
import { loadInsurers, type Insurer } from "@/lib/settings-insurers"
import { InsurerFormModal, BLANK_FORM, type InsurerFormState as FormState } from "@/components/settings/InsurerFormModal"
import { Plus, Pencil, Trash2, Search } from "lucide-react"

export function InsurersTable({ canWrite }: { canWrite: boolean }) {
  const [insurers, setInsurers] = useState<Insurer[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [addOpen, setAddOpen] = useState(false)
  const [editInsurer, setEditInsurer] = useState<Insurer | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    loadInsurers()
      .then(data => {
        setInsurers(data)
        setLoadError(null)
        setLoading(false)
      })
      .catch(() => {
        setLoadError("Failed to load insurers.")
        setLoading(false)
      })
  }, [refreshKey])

  const filtered = insurers.filter(ins => {
    const q = search.toLowerCase()
    return !q || ins.name.toLowerCase().includes(q) || (ins.fspNumber ?? "").toLowerCase().includes(q) || (ins.contactName ?? "").toLowerCase().includes(q)
  })

  const handleAdd = async (form: FormState) => {
    setSaving(true); setError(null)
    const res = await fetch("/api/insurers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        fspNumber: form.fspNumber || null,
        contactName: form.contactName || null,
        contactEmail: form.contactEmail || null,
        contactPhone: form.contactPhone || null,
        apiEndpoint: form.apiEndpoint || null,
        active: form.active,
      }),
    })
    setSaving(false)
    if (res.ok) {
      toast.success("Insurer added")
      setAddOpen(false)
      setRefreshKey(k => k + 1)
    } else {
      const d = await res.json() as { error?: string }
      setError(d.error ?? "Failed to add insurer")
    }
  }

  const handleEdit = async (form: FormState) => {
    if (!editInsurer) return
    setSaving(true); setError(null)
    const res = await fetch(`/api/insurers/${editInsurer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: form.name,
        fspNumber: form.fspNumber || null,
        contactName: form.contactName || null,
        contactEmail: form.contactEmail || null,
        contactPhone: form.contactPhone || null,
        apiEndpoint: form.apiEndpoint || null,
        active: form.active,
      }),
    })
    setSaving(false)
    if (res.ok) {
      toast.success("Insurer updated")
      setEditInsurer(null)
      setRefreshKey(k => k + 1)
    } else {
      const d = await res.json() as { error?: string }
      setError(d.error ?? "Failed to update insurer")
    }
  }

  const handleDelete = async (ins: Insurer) => {
    if (!confirm(`Delete insurer "${ins.name}"? This cannot be undone.`)) return
    const res = await fetch(`/api/insurers/${ins.id}`, { method: "DELETE" })
    if (res.ok) { toast.success("Insurer deleted"); setRefreshKey(k => k + 1) }
    else { const d = await res.json() as { error?: string }; toast.error(d.error ?? "Failed to delete") }
  }

  const editInitial: FormState = editInsurer
    ? {
        name: editInsurer.name,
        fspNumber: editInsurer.fspNumber ?? "",
        contactName: editInsurer.contactName ?? "",
        contactEmail: editInsurer.contactEmail ?? "",
        contactPhone: editInsurer.contactPhone ?? "",
        apiEndpoint: editInsurer.apiEndpoint ?? "",
        active: editInsurer.active,
      }
    : BLANK_FORM

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Insurers</h1>
          <p className="text-sm text-gray-500 mt-1">{insurers.length} insurer{insurers.length !== 1 ? "s" : ""} configured</p>
        </div>
        <Button
          onClick={() => { setAddOpen(true); setError(null) }}
          disabled={!canWrite}
          title={canWrite ? undefined : "Your role can view insurers but can't add, edit, or delete them"}
          className="bg-[#4F46E5] hover:bg-[#4338CA]"
        >
          <Plus className="h-4 w-4 mr-2" />Add Insurer
        </Button>
      </div>

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">{loadError}</div>
      )}

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-300" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, FSP number…"
          className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
        />
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden shadow-sm">
        {loading ? (
          <div className="p-12 text-center text-gray-400 text-sm">Loading insurers…</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-gray-400 text-sm">
            {insurers.length === 0 ? "No insurers configured yet. Add one to get started." : "No insurers match your search."}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50/50">
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Insurer</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase hidden md:table-cell">FSP Number</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase hidden lg:table-cell">Contact</th>
                <th className="px-4 py-3 text-left text-[11px] font-semibold text-gray-400 uppercase">Status</th>
                <th className="px-4 py-3 text-right text-[11px] font-semibold text-gray-400 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(ins => (
                <tr key={ins.id} className="border-b border-gray-50 hover:bg-amber-50/20 transition-colors">
                  <td className="px-4 py-3">
                    <p className="font-semibold text-gray-900">{ins.name}</p>
                    {ins.apiEndpoint && <p className="text-[11px] text-gray-400 truncate max-w-[200px]">{ins.apiEndpoint}</p>}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-gray-500 hidden md:table-cell">
                    {ins.fspNumber ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {ins.contactName
                      ? <div>
                          <p className="text-[12px] text-gray-700">{ins.contactName}</p>
                          {ins.contactEmail && <p className="text-[11px] text-gray-400">{ins.contactEmail}</p>}
                        </div>
                      : <span className="text-gray-300 text-[12px]">—</span>
                    }
                  </td>
                  <td className="px-4 py-3">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${ins.active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-600"}`}>
                      {ins.active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1 justify-end">
                      <button
                        onClick={() => { setEditInsurer(ins); setError(null) }}
                        disabled={!canWrite}
                        className="p-1.5 rounded hover:bg-gray-100 text-gray-300 hover:text-gray-600 disabled:opacity-30 disabled:pointer-events-none"
                        title={canWrite ? "Edit" : "Your role can't edit insurers"}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(ins)}
                        disabled={!canWrite}
                        className="p-1.5 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 disabled:opacity-30 disabled:pointer-events-none"
                        title={canWrite ? "Delete" : "Your role can't delete insurers"}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Modal */}
      <InsurerFormModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Insurer"
        initial={BLANK_FORM}
        onSubmit={handleAdd}
        saving={saving}
        error={error}
      />

      {/* Edit Modal */}
      <InsurerFormModal
        open={!!editInsurer}
        onClose={() => setEditInsurer(null)}
        title={`Edit — ${editInsurer?.name ?? ""}`}
        initial={editInitial}
        onSubmit={handleEdit}
        saving={saving}
        error={error}
      />
    </div>
  )
}
