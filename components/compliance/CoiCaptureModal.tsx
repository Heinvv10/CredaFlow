"use client"

import { X } from "lucide-react"
import { useFocusTrap } from "@/lib/hooks/use-focus-trap"

const COI_DETAILS_MAX = 2000

export type CoiFormState = {
  year: number
  hasConflict: boolean
  details: string
}

interface Props {
  yearOptions: number[]
  editing: boolean
  subjectLabel: string  // "my" or `${user.name}'s` — used in title
  form: CoiFormState
  setForm: React.Dispatch<React.SetStateAction<CoiFormState>>
  saving: boolean
  error: string | null
  onSubmit: (e: React.FormEvent) => void
  onClose: () => void
}

export function CoiCaptureModal({
  yearOptions,
  editing,
  subjectLabel,
  form,
  setForm,
  saving,
  error,
  onSubmit,
  onClose,
}: Props) {
  const detailsRequired = form.hasConflict
  const detailsPlaceholder = form.hasConflict
    ? "Describe the conflict, parties involved, and mitigation."
    : "Optional context, e.g. external directorships."
  const dialogRef = useFocusTrap<HTMLDivElement>(onClose)

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="coi-modal-title"
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 id="coi-modal-title" className="font-bold text-gray-900">
            {editing
              ? `Update ${subjectLabel} ${form.year} declaration`
              : `Declare ${subjectLabel} ${form.year} conflict of interest`}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600" aria-label="Close">
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
            <label htmlFor="coi-year" className="block text-xs font-semibold text-gray-600 mb-1.5">Year *</label>
            <select
              id="coi-year"
              value={form.year}
              onChange={(e) => setForm((f) => ({ ...f, year: parseInt(e.target.value, 10) }))}
              disabled={editing}
              required
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] disabled:bg-gray-50 disabled:text-gray-500"
            >
              {yearOptions.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Declaration</p>
            <label className="flex items-start gap-3 p-3 rounded-md border border-gray-200 hover:bg-gray-50 cursor-pointer">
              <input
                type="radio"
                name="hasConflict"
                checked={!form.hasConflict}
                onChange={() => setForm((f) => ({ ...f, hasConflict: false }))}
                className="mt-0.5"
              />
              <div className="text-sm text-gray-800">
                <strong>No conflict</strong> — I have no actual or potential conflicts of interest to disclose for the period.
              </div>
            </label>
            <label className="flex items-start gap-3 p-3 rounded-md border border-gray-200 hover:bg-gray-50 cursor-pointer">
              <input
                type="radio"
                name="hasConflict"
                checked={form.hasConflict}
                onChange={() => setForm((f) => ({ ...f, hasConflict: true }))}
                className="mt-0.5"
              />
              <div className="text-sm text-gray-800">
                <strong>Conflict to disclose</strong> — I have an actual or potential conflict to declare. Details required below.
              </div>
            </label>
          </div>

          <div>
            <label htmlFor="coi-details" className="block text-xs font-semibold text-gray-600 mb-1.5">
              Details {detailsRequired ? "*" : "(optional)"}
            </label>
            <textarea
              id="coi-details"
              value={form.details}
              onChange={(e) => setForm((f) => ({ ...f, details: e.target.value.slice(0, COI_DETAILS_MAX) }))}
              required={detailsRequired}
              maxLength={COI_DETAILS_MAX}
              rows={4}
              className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
              placeholder={detailsPlaceholder}
            />
            <p className="text-[10px] text-gray-400 mt-1 text-right">
              {form.details.length} / {COI_DETAILS_MAX}
            </p>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 transition-opacity"
              style={{ backgroundColor: "#4338CA" }}
            >
              {saving ? "Saving..." : editing ? "Update" : "Submit declaration"}
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
