"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { AlertTriangle } from "lucide-react"

interface Props {
  loanId: string
  reason: string
  requestedByName: string
  isRequester: boolean
  outstandingPrincipal: number
}

function formatZAR(cents: number) {
  return `R ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function WriteOffApprovalCard({ loanId, reason, requestedByName, isRequester, outstandingPrincipal }: Props) {
  const router = useRouter()
  const [rejectReason, setRejectReason] = useState("")
  const [showReject, setShowReject] = useState(false)
  const [loading, setLoading] = useState<"approve" | "reject" | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function submit(action: "approve" | "reject") {
    if (action === "reject" && !rejectReason.trim()) { setError("Rejection reason required"); return }
    setLoading(action); setError(null)
    try {
      const res = await fetch(`/api/loans/${loanId}/write-off`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(action === "approve" ? { action, confirm: true } : { action, reason: rejectReason }),
      })
      if (!res.ok) { const d = await res.json() as { error?: string }; setError(d.error ?? "Failed"); return }
      router.refresh()
    } catch {
      setError("Request failed")
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-amber-200 overflow-hidden shadow-sm">
      <div className="px-5 py-4 border-b border-amber-100 flex items-center gap-3 bg-amber-50">
        <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0" />
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-amber-500">Pending Write-Off Approval</p>
          <p className="text-sm font-semibold text-amber-800 mt-0.5">{formatZAR(outstandingPrincipal)} outstanding</p>
        </div>
      </div>

      <div className="px-5 py-4 space-y-2">
        <p className="text-xs text-gray-400">Requested by <span className="font-medium text-gray-700">{requestedByName}</span></p>
        <p className="text-[12px] text-gray-700 leading-relaxed">{reason}</p>

        {isRequester ? (
          <p className="text-xs text-amber-700 bg-amber-50 rounded px-3 py-2 mt-2">
            You requested this write-off. A different officer must approve or reject it (maker-checker).
          </p>
        ) : (
          <div className="pt-2 space-y-2">
            {showReject && (
              <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                placeholder="Reason for rejection *" rows={2}
                className="w-full border border-gray-200 rounded px-2.5 py-1.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-amber-400" />
            )}
            {error && <p className="text-xs text-red-600">{error}</p>}
            <div className="flex gap-2">
              <button onClick={() => submit("approve")} disabled={loading !== null}
                className="flex-1 py-2 rounded text-white text-sm font-medium disabled:opacity-50 bg-green-600">
                {loading === "approve" ? "Processing…" : "Approve Write-Off"}
              </button>
              {showReject ? (
                <button onClick={() => submit("reject")} disabled={loading !== null || !rejectReason.trim()}
                  className="flex-1 py-2 rounded text-white text-sm font-medium disabled:opacity-50 bg-red-600">
                  {loading === "reject" ? "Processing…" : "Confirm Reject"}
                </button>
              ) : (
                <button onClick={() => setShowReject(true)} disabled={loading !== null}
                  className="flex-1 py-2 rounded border border-red-300 text-red-600 text-sm font-medium hover:bg-red-50">
                  Reject
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
