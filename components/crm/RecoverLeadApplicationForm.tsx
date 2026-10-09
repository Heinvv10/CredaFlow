"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"

interface Candidate {
  id: string
  reference: string
  status: string
  submittedAt: string | null
}

export function RecoverLeadApplicationForm({
  leadId,
  candidates,
}: {
  leadId: string
  candidates: Candidate[]
}) {
  const router = useRouter()
  const [applicationId, setApplicationId] = useState(candidates[0]?.id ?? "")
  const [reason, setReason] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  async function recover() {
    if (!applicationId || reason.trim().length < 10) {
      setError("Select the exact application and enter a recovery reason of at least 10 characters.")
      return
    }
    setLoading(true)
    setError("")
    try {
      const response = await fetch(`/api/crm/leads/${leadId}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recoveryApplicationId: applicationId,
          recoveryReason: reason.trim(),
        }),
      })
      const result = await response.json()
      if (!response.ok) {
        setError(result.error ?? "Recovery failed")
        return
      }
      router.replace(`/applications/${result.applicationId}`)
      router.refresh()
    } catch {
      setError("Network error — recovery was not submitted.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-amber-200 bg-white p-6 shadow-sm">
      <div>
        <label className="mb-1 block text-xs font-semibold text-gray-600">
          Exact application
        </label>
        <select
          value={applicationId}
          onChange={(event) => setApplicationId(event.target.value)}
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
        >
          {candidates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.reference} · {candidate.status}
              {candidate.submittedAt
                ? ` · ${new Date(candidate.submittedAt).toLocaleDateString("en-ZA")}`
                : ""}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-semibold text-gray-600">
          Recovery reason
        </label>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          placeholder="Explain why this application is the correct conversion evidence."
          className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm"
        />
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <button
        type="button"
        onClick={recover}
        disabled={loading}
        className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {loading ? "Recovering…" : "Link Selected Application"}
      </button>
    </div>
  )
}
