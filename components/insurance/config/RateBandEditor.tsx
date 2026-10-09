"use client"

import { useState } from "react"
import { INSURED_LIFE_TYPES } from "@/lib/insurance/rating/band-match"
import type { GridBand } from "@/lib/insurance/rating/band-grid"
import {
  numberOrNull,
  readApiError,
  toRands,
  type RateBandRow,
} from "@/lib/settings-insurance-config"
import { toast } from "@/lib/toast"
import { RateBandGridView, LIFE_TYPE_LABELS } from "./RateBandGridView"
import type { InsuredLifeType, RateBasis } from "@prisma/client"

const inputCls =
  "w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"

interface BandForm {
  lifeType: InsuredLifeType
  minAge: string
  maxAge: string
  sumAssured: string
  premiumAmount: string
}

/**
 * A blank row. `lifeType` is never left empty: a `<select>` whose value matches
 * no option silently displays option[0], which has reached production twice in
 * this repo — the operator sees MAIN_MEMBER and the form holds "".
 */
const BLANK: BandForm = {
  lifeType: "MAIN_MEMBER",
  minAge: "",
  maxAge: "",
  sumAssured: "",
  premiumAmount: "",
}

function toGridBands(bands: RateBandRow[]): GridBand[] {
  return bands.map((band) => ({
    id: band.id,
    lifeType: band.lifeType,
    minAge: band.minAge,
    maxAge: band.maxAge,
    sumAssured: toRands(band.sumAssured),
    premiumAmount: toRands(band.premiumAmount),
  }))
}

/**
 * Entering and correcting the rows of a rate card.
 *
 * The form does NOT clear itself after a successful add. A real funeral card is
 * a dozen near-identical rows differing on one field — the 41-65 row of a tier
 * whose 18-40 row was just entered — and re-typing the life type and cover for
 * every one is how a rate card ends up flat. A flat card makes every downstream
 * rating assertion vacuous, so making non-uniform entry cheap is the point of
 * this component, not a convenience.
 *
 * Server errors are shown verbatim. These routes answer with which two bands
 * collide and under which basis; "Failed to save" would discard the only thing
 * that says what to change.
 */
export function RateBandEditor({
  tableId,
  basis,
  bands,
  canWrite,
  frozen,
  onChanged,
}: {
  tableId: string
  basis: RateBasis
  bands: RateBandRow[]
  canWrite: boolean
  /** True for ACTIVE and RETIRED tables — the API refuses every band write on those. */
  frozen: boolean
  onChanged: () => void
}) {
  const [form, setForm] = useState<BandForm>(BLANK)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const editable = canWrite && !frozen
  const set = (key: keyof BandForm, value: string) => setForm((f) => ({ ...f, [key]: value }))

  const payload = () => ({
    lifeType: form.lifeType,
    minAge: numberOrNull(form.minAge),
    maxAge: numberOrNull(form.maxAge),
    sumAssured: numberOrNull(form.sumAssured),
    premiumAmount: numberOrNull(form.premiumAmount),
  })

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(
        editingId
          ? `/api/insurance/rate-tables/${tableId}/bands/${editingId}`
          : `/api/insurance/rate-tables/${tableId}/bands`,
        {
          method: editingId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload()),
        }
      )
      if (!res.ok) {
        setError(await readApiError(res))
        return
      }
      toast.success(editingId ? "Band updated" : "Band added")
      setEditingId(null)
      onChanged()
    } catch {
      setError("The request could not be sent. Check the connection and try again.")
    } finally {
      setSaving(false)
    }
  }

  async function remove(band: GridBand) {
    if (
      !confirm(
        `Delete the ${LIFE_TYPE_LABELS[band.lifeType]} band for ages ${band.minAge}–${band.maxAge}?`
      )
    ) {
      return
    }
    setError(null)
    try {
      const res = await fetch(`/api/insurance/rate-tables/${tableId}/bands/${band.id}`, {
        method: "DELETE",
      })
      if (!res.ok) {
        setError(await readApiError(res))
        return
      }
      if (editingId === band.id) setEditingId(null)
      toast.success("Band deleted")
      onChanged()
    } catch {
      setError("The request could not be sent. Check the connection and try again.")
    }
  }

  function startEdit(band: GridBand) {
    setEditingId(band.id)
    setError(null)
    setForm({
      lifeType: band.lifeType,
      minAge: String(band.minAge),
      maxAge: String(band.maxAge),
      sumAssured: String(band.sumAssured),
      premiumAmount: String(band.premiumAmount),
    })
  }

  const gridBands = toGridBands(bands)

  return (
    <div className="space-y-5">
      {editable && (
        <div className="rounded-lg border border-gray-100 bg-gray-50/50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-[#1b1d24]">
              {editingId ? "Edit band" : "Add band"}
            </h4>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null)
                  setError(null)
                }}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                Cancel edit
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1">Life type</span>
              <select
                value={form.lifeType}
                onChange={(e) => set("lifeType", e.target.value as InsuredLifeType)}
                className={inputCls}
              >
                {INSURED_LIFE_TYPES.map((lifeType) => (
                  <option key={lifeType} value={lifeType}>
                    {LIFE_TYPE_LABELS[lifeType]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1">Min entry age</span>
              <input
                value={form.minAge}
                onChange={(e) => set("minAge", e.target.value)}
                className={inputCls}
                inputMode="numeric"
                placeholder="18"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1">Max entry age</span>
              <input
                value={form.maxAge}
                onChange={(e) => set("maxAge", e.target.value)}
                className={inputCls}
                inputMode="numeric"
                placeholder="65"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1">Cover (R)</span>
              <input
                value={form.sumAssured}
                onChange={(e) => set("sumAssured", e.target.value)}
                className={inputCls}
                inputMode="decimal"
                placeholder="10000"
              />
            </label>
            <label className="block">
              <span className="block text-xs font-semibold text-gray-500 mb-1">Premium (R/mo)</span>
              <input
                value={form.premiumAmount}
                onChange={(e) => set("premiumAmount", e.target.value)}
                className={inputCls}
                inputMode="decimal"
                placeholder="45.00"
              />
            </label>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="px-4 py-2 bg-[#4F46E5] hover:bg-[#4338CA] disabled:opacity-50 text-white text-sm font-semibold rounded-lg"
            >
              {saving ? "Saving…" : editingId ? "Save band" : "Add band"}
            </button>
            <p className="text-xs text-gray-400">
              The form keeps its values, so the next age band of the same tier is one field away.
            </p>
          </div>
          {error && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
              {error}
            </p>
          )}
        </div>
      )}

      {!editable && error && (
        <p className="text-xs text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded">
          {error}
        </p>
      )}

      <RateBandGridView
        basis={basis}
        bands={gridBands}
        onEditBand={editable ? startEdit : undefined}
        onAddAt={
          editable
            ? ({ lifeType, range, cover }) => {
                setEditingId(null)
                setError(null)
                setForm({
                  lifeType,
                  minAge: range ? String(range.minAge) : "",
                  maxAge: range ? String(range.maxAge) : "",
                  sumAssured: cover === null ? "" : String(cover),
                  premiumAmount: "",
                })
              }
            : undefined
        }
      />

      {editable && gridBands.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {gridBands.map((band) => (
            <span
              key={band.id}
              className="inline-flex items-center gap-2 text-[11px] bg-white border border-gray-200 rounded-full px-3 py-1"
            >
              <span className="text-gray-600">
                {`${LIFE_TYPE_LABELS[band.lifeType]} ${band.minAge}–${band.maxAge}`}
              </span>
              <button
                type="button"
                onClick={() => remove(band)}
                className="text-gray-400 hover:text-red-600"
                title="Delete this band"
              >
                &times;
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
