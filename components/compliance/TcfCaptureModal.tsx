"use client"

import { X } from "lucide-react"
import { useFocusTrap } from "@/lib/hooks/use-focus-trap"

export type TcfOutcomeDef = {
  key: "outcome1" | "outcome2" | "outcome3" | "outcome4" | "outcome5" | "outcome6"
  short: string
  full: string
}

export type TcfFormState = {
  period: string
  outcome1: boolean
  outcome2: boolean
  outcome3: boolean
  outcome4: boolean
  outcome5: boolean
  outcome6: boolean
  notes: string
}

interface Props {
  outcomes: TcfOutcomeDef[]
  periodOptions: string[]
  currentPeriod: string
  editingPeriod: string | null
  form: TcfFormState
  setForm: React.Dispatch<React.SetStateAction<TcfFormState>>
  saving: boolean
  error: string | null
  onSubmit: (e: React.FormEvent) => void
  onClose: () => void
}

export function TcfCaptureModal({
  outcomes,
  periodOptions,
  currentPeriod,
  editingPeriod,
  form,
  setForm,
  saving,
  error,
  onSubmit,
  onClose,
}: Props) {
  const dialogRef = useFocusTrap<HTMLDivElement>(onClose)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tcf-modal-title"
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 id="tcf-modal-title" className="font-bold text-gray-900">
            {editingPeriod ? `Update TCF outcomes — ${editingPeriod}` : "Record TCF outcomes"}
          </h2>
          <button onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={onSubmit} className="p-6 space-y-5">
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Period *</label>
            <select
              value={form.period}
              onChange={(e) => setForm((f) => ({ ...f, period: e.target.value }))}
              disabled={!!editingPeriod}
              required
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] disabled:bg-gray-50 disabled:text-gray-500"
            >
              {periodOptions.map((p) => (
                <option key={p} value={p}>{p}{p === currentPeriod ? " (current)" : ""}</option>
              ))}
            </select>
          </div>

          <div className="space-y-3">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">FSCA TCF outcomes</p>
            {outcomes.map((def, idx) => (
              <label key={def.key} className="flex items-start gap-3 p-3 rounded-md border border-gray-200 hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form[def.key]}
                  onChange={(e) => setForm((f) => ({ ...f, [def.key]: e.target.checked }))}
                  className="mt-0.5 rounded border-gray-300"
                />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-gray-800">
                    <span className="text-[#4F46E5]">Outcome {idx + 1}:</span> {def.short}
                  </div>
                  <p className="text-xs text-gray-600 mt-0.5 leading-relaxed">{def.full}</p>
                </div>
              </label>
            ))}
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1.5">Notes</label>
            <textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              rows={3}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
              placeholder="Evidence, gaps, remedial actions for the quarter..."
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 transition-opacity"
              style={{ backgroundColor: "#4338CA" }}
            >
              {saving ? "Saving..." : editingPeriod ? "Update" : "Save"}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
