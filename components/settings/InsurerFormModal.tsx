"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"

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

const inputCls = "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"

export const BLANK_FORM = {
  name: "",
  fspNumber: "",
  contactName: "",
  contactEmail: "",
  contactPhone: "",
  apiEndpoint: "",
  active: true,
}

export type InsurerFormState = typeof BLANK_FORM

function InsurerForm({
  initial,
  onSubmit,
  onCancel,
  saving,
  error,
}: {
  initial: InsurerFormState
  onSubmit: (data: InsurerFormState) => void
  onCancel: () => void
  saving: boolean
  error: string | null
}) {
  const [form, setForm] = useState<InsurerFormState>(initial)
  useEffect(() => { setForm(initial) }, [initial])
  const set = (key: keyof InsurerFormState, value: string | boolean) => setForm(f => ({ ...f, [key]: value }))

  return (
    <div className="space-y-3">
      <Field label="Insurer Name *">
        <input value={form.name} onChange={e => set("name", e.target.value)} className={inputCls} placeholder="e.g. Old Mutual" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="FSP Number">
          <input value={form.fspNumber} onChange={e => set("fspNumber", e.target.value)} className={inputCls} placeholder="FSP 12345" />
        </Field>
        <Field label="Contact Name">
          <input value={form.contactName} onChange={e => set("contactName", e.target.value)} className={inputCls} placeholder="Jane Smith" />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Contact Email">
          <input type="email" value={form.contactEmail} onChange={e => set("contactEmail", e.target.value)} className={inputCls} placeholder="contact@insurer.example" />
        </Field>
        <Field label="Contact Phone">
          <input value={form.contactPhone} onChange={e => set("contactPhone", e.target.value)} className={inputCls} placeholder="+27 11 000 0000" />
        </Field>
      </div>
      <Field label="API Endpoint">
        <input value={form.apiEndpoint} onChange={e => set("apiEndpoint", e.target.value)} className={inputCls} placeholder="https://api.insurer.example" />
      </Field>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          id="insurer-active"
          checked={form.active}
          onChange={e => set("active", e.target.checked)}
          className="rounded border-gray-300 text-amber-600 focus:ring-amber-300"
        />
        <label htmlFor="insurer-active" className="text-sm text-gray-700">Active</label>
      </div>
      {error && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded">{error}</p>}
      <div className="flex gap-2 pt-2">
        <Button
          onClick={() => onSubmit(form)}
          disabled={saving || !form.name.trim()}
          className="flex-1 bg-[#4F46E5] hover:bg-[#4338CA]"
        >
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="outline" onClick={onCancel} className="flex-1">Cancel</Button>
      </div>
    </div>
  )
}

export function InsurerFormModal({
  open,
  onClose,
  title,
  initial,
  onSubmit,
  saving,
  error,
}: {
  open: boolean
  onClose: () => void
  title: string
  initial: InsurerFormState
  onSubmit: (data: InsurerFormState) => void
  saving: boolean
  error: string | null
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <InsurerForm initial={initial} onSubmit={onSubmit} onCancel={onClose} saving={saving} error={error} />
    </Modal>
  )
}
