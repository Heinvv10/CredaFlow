"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Plus, Pencil } from "lucide-react"
import { formatDate } from "@/lib/utils"
import { CoiCaptureModal, type CoiFormState } from "./CoiCaptureModal"

export type CoiRosterRow = {
  userId: string
  name: string | null
  email: string
  role: string
  declarationId?: string
  hasConflict?: boolean
  details?: string | null
  declaredAt?: string
}

type Props = {
  rows: CoiRosterRow[]
  year: number
  yearOptions: number[]
  viewerId: string
  viewerRole: string
}

const emptyForm = (year: number): CoiFormState => ({ year, hasConflict: false, details: "" })

function canActOn(row: CoiRosterRow, viewerId: string, viewerRole: string): boolean {
  if (row.userId === viewerId) return true
  return viewerRole === "ADMIN" || viewerRole === "SUPER_ADMIN"
}

export function CoiClient({ rows, year, yearOptions, viewerId, viewerRole }: Props) {
  const router = useRouter()
  const [showForm, setShowForm] = useState(false)
  const [activeRow, setActiveRow] = useState<CoiRosterRow | null>(null)
  const [form, setForm] = useState<CoiFormState>(emptyForm(year))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const open = (row: CoiRosterRow) => {
    setActiveRow(row)
    setError(null)
    if (row.declarationId) {
      setForm({
        year,
        hasConflict: row.hasConflict ?? false,
        details: row.details ?? "",
      })
    } else {
      setForm(emptyForm(year))
    }
    setShowForm(true)
  }
  const close = () => { setShowForm(false); setActiveRow(null); setError(null) }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeRow) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/users/${activeRow.userId}/coi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          year: form.year,
          hasConflict: form.hasConflict,
          details: form.details || undefined,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error ?? "Failed to save declaration")
      }
      close()
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setSaving(false)
    }
  }

  const changeYear = (next: number) => {
    const params = new URLSearchParams()
    params.set("year", String(next))
    router.push(`/compliance/coi?${params.toString()}`)
  }

  const ownRow = rows.find((r) => r.userId === viewerId)
  const declaredCount = rows.filter((r) => r.declarationId).length
  const conflictCount = rows.filter((r) => r.declarationId && r.hasConflict).length
  const pct = rows.length > 0 ? Math.round((declaredCount / rows.length) * 100) : 0
  const rateColor = pct < 60 ? "#991B1B" : pct < 90 ? "#92400E" : "#065F46"

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#1b1d24]">Conflict of Interest Declarations</h1>
          <p className="text-sm text-gray-500 mt-1">FSCA Code of Conduct · annual self-attestation</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Link href="/compliance" className="text-sm text-gray-500 hover:text-gray-700">
            ← Compliance
          </Link>
          <select
            value={year}
            onChange={(e) => changeYear(parseInt(e.target.value, 10))}
            disabled={saving}
            className="px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] disabled:opacity-50 disabled:cursor-not-allowed"
            aria-label="Year"
          >
            {yearOptions.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          {ownRow && (
            <button
              onClick={() => open(ownRow)}
              className="flex items-center gap-2 px-4 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA] transition-colors"
            >
              <Plus className="h-4 w-4" />
              {ownRow.declarationId ? "Update my declaration" : `Declare for ${year}`}
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Staff users", value: rows.length, color: "#1565c0" },
          { label: `Declared ${year}`, value: `${declaredCount} / ${rows.length}`, color: declaredCount === rows.length && rows.length > 0 ? "#065F46" : "#92400E" },
          { label: "Conflicts disclosed", value: conflictCount, color: conflictCount > 0 ? "#92400E" : "#6B7280" },
          { label: "Compliance rate", value: rows.length > 0 ? `${pct}%` : "—", color: rateColor },
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
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">User</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">Role</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">{year} status</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">Conflict?</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">Details</th>
              <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">Declared at</th>
              <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wide text-gray-400">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const declared = !!row.declarationId
              const isSelf = row.userId === viewerId
              return (
                <tr
                  key={row.userId}
                  className="border-b border-gray-50 hover:bg-gray-50 transition-colors"
                  style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}
                >
                  <td className="px-4 py-3.5">
                    <div className="text-[13px] font-semibold text-gray-800">
                      {row.name ?? row.email}
                      {isSelf && <span className="ml-2 text-[9px] font-semibold uppercase tracking-wide text-[#4F46E5]">You</span>}
                    </div>
                    <div className="text-[11px] text-gray-500">{row.email}</div>
                  </td>
                  <td className="px-4 py-3.5 text-[12px] text-gray-600 whitespace-nowrap">{row.role}</td>
                  <td className="px-4 py-3.5">
                    {declared ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#D1FAE5] text-[#065F46]">Declared</span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-500">Not yet</span>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    {!declared ? (
                      <span className="text-gray-300">—</span>
                    ) : row.hasConflict ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-[#FEF3C7] text-[#92400E]">Disclosed</span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-500">None</span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-[12px] text-gray-600 max-w-[260px]">
                    {declared && row.hasConflict ? (
                      <span className="block truncate" title={row.details ?? ""}>{row.details ?? ""}</span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-[12px] text-gray-600 whitespace-nowrap">
                    {declared && row.declaredAt ? formatDate(row.declaredAt) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3.5 text-right">
                    {canActOn(row, viewerId, viewerRole) ? (
                      <button
                        onClick={() => open(row)}
                        className="inline-flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded border border-gray-200 hover:border-[#4338CA] hover:text-[#4F46E5] transition-colors"
                      >
                        <Pencil className="h-3 w-3" /> {isSelf ? (declared ? "Update" : "Declare") : (declared ? "Edit" : "Record")}
                      </button>
                    ) : (
                      <span className="text-gray-300 text-[11px]">—</span>
                    )}
                  </td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400 text-sm">
                  No staff users for this tenant.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showForm && activeRow && (
        <CoiCaptureModal
          yearOptions={yearOptions}
          editing={!!activeRow.declarationId}
          subjectLabel={activeRow.userId === viewerId ? "my" : `${activeRow.name ?? activeRow.email}'s`}
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
