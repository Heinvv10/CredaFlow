"use client"

import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Briefcase, X, CheckCircle, AlertTriangle, Loader2 } from "lucide-react"

interface Firm {
  id: string
  name: string
  contactPerson: string | null
  phone: string | null
  email: string | null
}

interface Props {
  loanIds: string[]
  onClose: () => void
  onSuccess: () => void
}

interface ReferralResult { loanId: string; ok: boolean; error?: string }

export function BulkAttorneyReferModal({ loanIds, onClose, onSuccess }: Props) {
  const [firms, setFirms] = useState<Firm[]>([])
  const [selectedFirmId, setSelectedFirmId] = useState("")
  const [manualFirmName, setManualFirmName] = useState("")
  const [matterNumber, setMatterNumber] = useState("")
  const [notes, setNotes] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [results, setResults] = useState<ReferralResult[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/settings/attorneys")
      .then((r) => {
        if (!r.ok) throw new Error("Failed to load")
        return r.json()
      })
      .then((data: Firm[]) => setFirms(data))
      .catch(() => setLoadError("Could not load attorney firms"))
  }, [])

  const selectedFirm = firms.find((f) => f.id === selectedFirmId) ?? null

  const firmName = selectedFirm ? selectedFirm.name : manualFirmName

  async function handleSubmit() {
    if (!firmName.trim()) return
    setSubmitting(true)

    const referralDate = new Date().toISOString()
    const body = {
      firmId: selectedFirm?.id ?? undefined,
      firmName: firmName.trim(),
      contactPerson: selectedFirm?.contactPerson ?? undefined,
      contactPhone: selectedFirm?.phone ?? undefined,
      contactEmail: selectedFirm?.email ?? undefined,
      referralDate,
      ...(matterNumber ? { matterNumber: matterNumber.trim() } : {}),
      ...(notes ? { notes: notes.trim() } : {}),
    }

    const settled = await Promise.allSettled(
      loanIds.map((id) =>
        fetch(`/api/loans/${id}/attorney-referral`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then(async (res) => ({
          loanId: id,
          ok: res.ok,
          error: res.ok ? undefined : ((await res.json()) as { error?: string }).error,
        }))
      )
    )

    const results: ReferralResult[] = settled.map((s, i) =>
      s.status === "fulfilled" ? s.value : { loanId: loanIds[i], ok: false, error: "Network error" }
    )
    setResults(results)
    setSubmitting(false)

    if (results.every((r) => r.ok)) {
      onSuccess()
    }
  }

  const allDone = results !== null
  const failedCount = results?.filter((r) => !r.ok).length ?? 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div className="flex items-center gap-2">
            <Briefcase className="h-5 w-5 text-purple-600" />
            <h2 className="font-semibold text-gray-900">Bulk Attorney Referral</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-gray-600">
            Referring <strong>{loanIds.length}</strong> loan{loanIds.length !== 1 ? "s" : ""} for pre-enforcement legal review.
          </p>
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
            This referral does not authorise court enforcement. Section 129 delivery and every applicable NCA section 130 prerequisite must be verified separately before legal proceedings begin.
          </div>

          {loadError ? (
            <p className="text-sm text-red-600">{loadError}</p>
          ) : (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Attorney Firm</label>
              {firms.length > 0 ? (
                <select
                  value={selectedFirmId}
                  onChange={(e) => setSelectedFirmId(e.target.value)}
                  disabled={submitting || allDone}
                  className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400"
                >
                  <option value="">— select firm —</option>
                  {firms.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={manualFirmName}
                  onChange={(e) => setManualFirmName(e.target.value)}
                  placeholder="Attorney firm name"
                  disabled={submitting || allDone}
                  className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400"
                />
              )}
              {selectedFirm && (
                <p className="text-xs text-gray-400 mt-1">
                  {[selectedFirm.contactPerson, selectedFirm.phone, selectedFirm.email].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Matter Number <span className="font-normal text-gray-400">(optional)</span></label>
            <input
              type="text"
              value={matterNumber}
              onChange={(e) => setMatterNumber(e.target.value)}
              placeholder="e.g. M2024/001"
              disabled={submitting || allDone}
              className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notes <span className="font-normal text-gray-400">(optional)</span></label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              disabled={submitting || allDone}
              placeholder="Instructions or context for the firm..."
              className="w-full text-sm border border-gray-200 rounded-md px-3 py-2 focus:outline-none focus:ring-1 focus:ring-purple-400 resize-none"
            />
          </div>

          {/* Results */}
          {results && (
            <div className={`rounded-lg p-3 text-sm ${failedCount === 0 ? "bg-green-50 border border-green-200" : "bg-amber-50 border border-amber-200"}`}>
              {failedCount === 0 ? (
                <div className="flex items-center gap-2 text-green-700">
                  <CheckCircle className="h-4 w-4 shrink-0" />
                  All {results.length} loans referred successfully.
                </div>
              ) : (
                <div className="text-amber-800">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    {results.length - failedCount} succeeded, {failedCount} failed.
                  </div>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {results.filter((r) => !r.ok).map((r) => (
                      <li key={r.loanId}>&bull; {r.loanId}: {r.error ?? "unknown error"}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {allDone ? "Close" : "Cancel"}
          </Button>
          {!allDone && (
            <Button
              onClick={handleSubmit}
              disabled={!firmName.trim() || submitting}
              className="bg-purple-600 hover:bg-purple-700"
            >
              {submitting ? (
                <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Referring…</>
              ) : (
                <><Briefcase className="h-4 w-4 mr-1" />Refer {loanIds.length} loan{loanIds.length !== 1 ? "s" : ""}</>
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
