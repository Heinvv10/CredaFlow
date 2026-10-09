"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AlertCircle, CheckCircle, FileText } from "lucide-react"

interface Props {
  applicationId: string
  documentSha256: string
  acknowledged: boolean
}

export function PasqAcknowledgementCard({ applicationId, documentSha256, acknowledged }: Props) {
  const router = useRouter()
  const [opened, setOpened] = useState(acknowledged)
  const [confirmed, setConfirmed] = useState(acknowledged)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function acknowledge() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch(`/api/applications/${applicationId}/pasq/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ documentSha256 }),
      })
      if (!res.ok) {
        const data = await res.json() as { error?: string }
        setError(data.error ?? "PASQ acknowledgement failed")
        return
      }
      router.refresh()
    } catch {
      setError("PASQ acknowledgement request failed")
    } finally {
      setSubmitting(false)
    }
  }

  if (acknowledged) {
    return (
      <div className="mb-5 flex items-start gap-3 rounded-xl border border-green-200 bg-green-50 p-4">
        <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
        <div>
          <p className="text-sm font-semibold text-green-800">PASQ acknowledged</p>
          <p className="mt-0.5 text-xs text-green-700">Your acknowledgement is bound to document {documentSha256.slice(0, 12)}….</p>
          <a href={`/api/applications/${applicationId}/pasq`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-semibold text-green-800 underline">View the acknowledged PASQ</a>
        </div>
      </div>
    )
  }

  return (
    <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        <div className="flex-1">
          <p className="text-sm font-semibold text-amber-800">Action required: review your PASQ</p>
          <p className="mt-0.5 text-xs text-amber-700">Open the exact Pre-Agreement Statement &amp; Quotation, review the costs and elected credit-life cover, then acknowledge that document. Your application cannot be approved before this step.</p>
          <a href={`/api/applications/${applicationId}/pasq`} target="_blank" rel="noreferrer" onClick={() => setOpened(true)} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[#4F46E5] px-4 py-2 text-sm font-bold text-white">
            <FileText className="h-4 w-4" />Open PASQ
          </a>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-xs text-amber-900">
            <input type="checkbox" checked={confirmed} disabled={!opened} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[#4F46E5]" />
            <span>I opened and reviewed document {documentSha256.slice(0, 12)}…, including the total cost of credit and my credit-life election.</span>
          </label>
          <button type="button" disabled={!opened || !confirmed || submitting} onClick={acknowledge} className="mt-3 rounded-lg border border-amber-700 px-4 py-2 text-sm font-bold text-amber-900 disabled:cursor-not-allowed disabled:opacity-50">
            {submitting ? "Recording..." : "Acknowledge this PASQ"}
          </button>
          {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  )
}
