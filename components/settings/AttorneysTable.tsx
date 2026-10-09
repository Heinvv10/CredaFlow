"use client"

import { useState, useEffect, useCallback } from "react"
import { toast } from "@/lib/toast"
import { Button } from "@/components/ui/button"
import { loadAttorneyFirms, type AttorneyFirm } from "@/lib/settings-attorneys"
import { Plus, Pencil, Trash2, Search, Briefcase } from "lucide-react"

function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="font-bold text-gray-900 text-base">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">&times;</button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  )
}

const inputCls = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-300"

const BLANK: AttorneyFirm = {
  id: "",
  name: "",
  contactPerson: "",
  phone: "",
  email: "",
  address: "",
  specialisation: "",
  active: true,
  createdAt: "",
}

type FormState = Pick<AttorneyFirm, "name" | "contactPerson" | "phone" | "email" | "address" | "specialisation" | "active">

function FirmForm({ initial, onSubmit, saving }: { initial: FormState; onSubmit: (f: FormState) => void; saving: boolean }) {
  const [form, setForm] = useState<FormState>(initial)
  const set = (k: keyof FormState, v: string | boolean) => setForm(p => ({ ...p, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); onSubmit(form) }} className="space-y-4">
      <Field label="Firm Name *">
        <input required className={inputCls} value={form.name} onChange={e => set("name", e.target.value)} placeholder="e.g. Van der Merwe Attorneys" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Contact Person">
          <input className={inputCls} value={form.contactPerson ?? ""} onChange={e => set("contactPerson", e.target.value)} />
        </Field>
        <Field label="Phone">
          <input className={inputCls} value={form.phone ?? ""} onChange={e => set("phone", e.target.value)} />
        </Field>
      </div>
      <Field label="Email">
        <input type="email" className={inputCls} value={form.email ?? ""} onChange={e => set("email", e.target.value)} />
      </Field>
      <Field label="Address">
        <input className={inputCls} value={form.address ?? ""} onChange={e => set("address", e.target.value)} />
      </Field>
      <Field label="Specialisation">
        <input className={inputCls} value={form.specialisation ?? ""} onChange={e => set("specialisation", e.target.value)} placeholder="e.g. Debt recovery, NCA matters" />
      </Field>
      <div className="flex items-center gap-2">
        <input type="checkbox" id="active" checked={form.active} onChange={e => set("active", e.target.checked)} className="rounded" />
        <label htmlFor="active" className="text-sm text-gray-600">Active</label>
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Button type="submit" disabled={saving} size="sm">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  )
}

export function AttorneysTable() {
  const [firms, setFirms] = useState<AttorneyFirm[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")
  const [showInactive, setShowInactive] = useState(false)
  const [modal, setModal] = useState<"add" | "edit" | null>(null)
  const [selected, setSelected] = useState<AttorneyFirm | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    loadAttorneyFirms(showInactive)
      .then(d => { setFirms(d); setError(null) })
      .catch(() => setError("Failed to load attorney firms."))
      .finally(() => setLoading(false))
  }, [showInactive])

  useEffect(() => { load() }, [load])

  const filtered = firms.filter(f =>
    f.name.toLowerCase().includes(search.toLowerCase()) ||
    (f.contactPerson ?? "").toLowerCase().includes(search.toLowerCase()) ||
    (f.specialisation ?? "").toLowerCase().includes(search.toLowerCase())
  )

  async function handleAdd(form: FormState) {
    setSaving(true)
    try {
      const res = await fetch("/api/settings/attorneys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success("Attorney firm added")
      setModal(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add firm")
    } finally {
      setSaving(false)
    }
  }

  async function handleEdit(form: FormState) {
    if (!selected) return
    setSaving(true)
    try {
      const res = await fetch(`/api/settings/attorneys/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      toast.success("Attorney firm updated")
      setModal(null)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update firm")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(firm: AttorneyFirm) {
    if (!confirm(`Remove "${firm.name}" from the register?`)) return
    try {
      const res = await fetch(`/api/settings/attorneys/${firm.id}`, {
        method: "DELETE",
        credentials: "include",
      })
      const data = await res.json() as { deactivated?: boolean; deleted?: boolean; error?: string }
      if (!res.ok) {
        toast.error(data.error ?? "Failed to remove firm")
        return
      }
      toast.success(data.deactivated ? "Firm deactivated (has existing referrals)" : "Firm removed")
      load()
    } catch {
      toast.error("Failed to remove firm")
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div className="flex items-center gap-2">
            <Briefcase className="h-5 w-5 text-purple-600" />
            <h2 className="font-bold text-gray-900">Attorney Firms</h2>
            <span className="text-xs bg-gray-100 text-gray-500 px-2 py-0.5 rounded-full">{filtered.length}</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer">
              <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="rounded" />
              Show inactive
            </label>
            <Button size="sm" onClick={() => setModal("add")}>
              <Plus className="h-4 w-4 mr-1" /> Add Firm
            </Button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700 mb-4">{error}</div>
        )}

        <div className="relative mb-4">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            className="w-full pl-9 pr-4 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-200"
            placeholder="Search by name, contact, specialisation…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="space-y-2">
            {[1,2,3].map(i => <div key={i} className="h-14 bg-gray-50 rounded-lg animate-pulse" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-gray-400">
            <Briefcase className="h-10 w-10 mx-auto mb-2 opacity-30" />
            <p className="text-sm">No attorney firms found</p>
            <p className="text-xs mt-1">Add firms here so agents can pick from them when making referrals.</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {filtered.map(firm => (
              <div key={firm.id} className="flex items-center justify-between py-3 gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-sm text-gray-900 truncate">{firm.name}</p>
                    {!firm.active && (
                      <span className="text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded uppercase font-semibold">Inactive</span>
                    )}
                    {firm.specialisation && (
                      <span className="text-[10px] bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded font-medium truncate max-w-[120px]">{firm.specialisation}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5 text-xs text-gray-400">
                    {firm.contactPerson && <span>{firm.contactPerson}</span>}
                    {firm.phone && <span>{firm.phone}</span>}
                    {firm.email && <span className="truncate">{firm.email}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => { setSelected(firm); setModal("edit") }}
                    className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700"
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(firm)}
                    className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600"
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal open={modal === "add"} onClose={() => setModal(null)} title="Add Attorney Firm">
        <FirmForm initial={BLANK} onSubmit={handleAdd} saving={saving} />
      </Modal>

      <Modal open={modal === "edit" && !!selected} onClose={() => { setModal(null); setSelected(null) }} title="Edit Attorney Firm">
        {selected && (
          <FirmForm initial={selected} onSubmit={handleEdit} saving={saving} />
        )}
      </Modal>
    </div>
  )
}
