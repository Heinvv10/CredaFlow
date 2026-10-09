"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Plus, X, Check, Pencil } from "lucide-react"
import { formatDate } from "@/lib/utils"
import { TcfCaptureModal, type TcfFormState, type TcfOutcomeDef } from "./TcfCaptureModal"

type TcfOutcome = {
  id: string
  period: string
  outcome1: boolean
  outcome2: boolean
  outcome3: boolean
  outcome4: boolean
  outcome5: boolean
  outcome6: boolean
  notes: string | null
  completedBy: string | null
  completedAt: string
  updatedAt: string
}

// FSCA TCF outcomes 1-6, abbreviated for column headers.
// Full text is rendered in the capture/edit modal.
const OUTCOMES: TcfOutcomeDef[] = [
  { key: "outcome1", short: "Culture",        full: "Customers can be confident they are dealing with firms where the fair treatment of customers is central to the corporate culture." },
  { key: "outcome2", short: "Right product",  full: "Products and services marketed and sold are designed to meet the needs of identified customer groups and are targeted accordingly." },
  { key: "outcome3", short: "Clear info",     full: "Customers are given clear information and are kept appropriately informed before, during, and after the time of contracting." },
  { key: "outcome4", short: "Suitable advice",full: "Where advice is given, it is suitable and takes account of customer circumstances." },
  { key: "outcome5", short: "Performance",    full: "Products perform as firms have led customers to expect, and the associated service is of an acceptable standard." },
  { key: "outcome6", short: "No barriers",    full: "Customers do not face unreasonable post-sale barriers to change product, switch provider, submit a claim, or make a complaint." },
]

function countAchieved(o: TcfOutcome): number {
  return OUTCOMES.reduce((n, def) => n + (o[def.key] ? 1 : 0), 0)
}

function periodOptions(currentPeriod: string): string[] {
  const [yearStr, qStr] = currentPeriod.split("-Q")
  const year = parseInt(yearStr, 10)
  const q = parseInt(qStr, 10)
  // Offer current quarter + previous 7 (two years of history)
  const opts: string[] = []
  for (let i = 0; i < 8; i++) {
    let yy = year
    let qq = q - i
    while (qq <= 0) { qq += 4; yy -= 1 }
    opts.push(`${yy}-Q${qq}`)
  }
  return opts
}

const emptyForm = (period: string): TcfFormState => ({
  period,
  outcome1: false, outcome2: false, outcome3: false,
  outcome4: false, outcome5: false, outcome6: false,
  notes: "",
})

export function TcfClient({ outcomes, currentPeriod }: { outcomes: TcfOutcome[]; currentPeriod: string }) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<TcfOutcome | null>(null)
  const [form, setForm] = useState<TcfFormState>(emptyForm(currentPeriod))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const openCreate = () => {
    setEditing(null)
    setForm(emptyForm(currentPeriod))
    setError(null)
    setShowForm(true)
  }
  const openEdit = (o: TcfOutcome) => {
    setEditing(o)
    setForm({
      period: o.period,
      outcome1: o.outcome1, outcome2: o.outcome2, outcome3: o.outcome3,
      outcome4: o.outcome4, outcome5: o.outcome5, outcome6: o.outcome6,
      notes: o.notes ?? "",
    })
    setError(null)
    setShowForm(true)
  }
  const close = () => { setShowForm(false); setEditing(null); setError(null) }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/compliance/tcf", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          period: form.period,
          outcome1: form.outcome1,
          outcome2: form.outcome2,
          outcome3: form.outcome3,
          outcome4: form.outcome4,
          outcome5: form.outcome5,
          outcome6: form.outcome6,
          notes: form.notes || undefined,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? "Failed to save TCF outcome")
      }
      close()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setSaving(false)
    }
  }

  const currentRow = outcomes.find((o) => o.period === currentPeriod)
  const totalAchieved = outcomes.reduce((s, o) => s + countAchieved(o), 0)
  const totalPossible = outcomes.length * 6
  const allSixCount = outcomes.filter((o) => countAchieved(o) === 6).length

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1b1d24]">Treating Customers Fairly</h1>
          <p className="text-sm text-gray-500 mt-1">FSCA TCF outcomes · quarterly self-assessment</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/compliance" className="text-sm text-gray-500 hover:text-gray-700">
            ← Compliance
          </Link>
          <button
            onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA] transition-colors"
          >
            <Plus className="h-4 w-4" />
            {currentRow ? `Update ${currentPeriod}` : `Record ${currentPeriod}`}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Quarters logged", value: outcomes.length, color: "#1565c0" },
          { label: "Current quarter", value: currentRow ? `${countAchieved(currentRow)} / 6` : "Not yet", color: currentRow ? "#065F46" : "#92400E" },
          { label: "All 6 achieved", value: allSixCount, color: "#065F46" },
          { label: "Overall outcome rate", value: totalPossible > 0 ? `${Math.round((totalAchieved / totalPossible) * 100)}%` : "—", color: "#4F46E5" },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl shadow-sm p-4" style={{ borderLeft: `4px solid ${s.color}` }}>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">{s.label}</p>
            <p className="text-2xl font-extrabold" style={{ color: s.color }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">Period</th>
              {OUTCOMES.map((o, i) => (
                <th key={o.key} className="px-2 py-3 text-center text-[11px] font-semibold uppercase tracking-wide text-gray-400" title={o.full}>
                  <div>{i + 1}</div>
                  <div className="text-[9px] font-normal normal-case mt-0.5">{o.short}</div>
                </th>
              ))}
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">Score</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">Completed</th>
              <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody>
            {outcomes.map((o, i) => {
              const score = countAchieved(o)
              const scoreColor = score === 6 ? "#065F46" : score >= 4 ? "#92400E" : "#991B1B"
              return (
                <tr
                  key={o.id}
                  className="border-b border-gray-50 hover:bg-gray-50 transition-colors"
                  style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}
                >
                  <td className="px-4 py-3.5 text-[13px] font-semibold text-gray-700 whitespace-nowrap">
                    {o.period}
                    {o.period === currentPeriod && (
                      <span className="ml-2 text-[9px] font-semibold uppercase tracking-wide text-[#4F46E5]">Current</span>
                    )}
                  </td>
                  {OUTCOMES.map((def) => (
                    <td key={def.key} className="px-2 py-3.5 text-center">
                      {o[def.key] ? (
                        <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-[#D1FAE5]">
                          <Check className="h-3.5 w-3.5 text-[#065F46]" />
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-gray-100">
                          <X className="h-3.5 w-3.5 text-gray-400" />
                        </span>
                      )}
                    </td>
                  ))}
                  <td className="px-4 py-3.5">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded text-[12px] font-bold" style={{ color: scoreColor }}>
                      {score} / 6
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-[12px] text-gray-600 whitespace-nowrap">
                    {formatDate(o.completedAt)}
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    <button
                      onClick={() => openEdit(o)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded border border-gray-200 hover:border-[#4338CA] hover:text-[#4F46E5] transition-colors"
                    >
                      <Pencil className="h-3 w-3" /> Edit
                    </button>
                  </td>
                </tr>
              )
            })}
            {outcomes.length === 0 && (
              <tr>
                <td colSpan={OUTCOMES.length + 4} className="px-4 py-12 text-center text-gray-400 text-sm">
                  No TCF outcomes recorded yet. Use “Record {currentPeriod}” to start the current quarter’s self-assessment.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && (
        <TcfCaptureModal
          outcomes={OUTCOMES}
          periodOptions={periodOptions(currentPeriod)}
          currentPeriod={currentPeriod}
          editingPeriod={editing?.period ?? null}
          form={form}
          setForm={setForm}
          saving={saving}
          error={error}
          onSubmit={submit}
          onClose={close}
        />
      )}
    </div>
  )
}
