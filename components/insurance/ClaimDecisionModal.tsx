"use client"

import { useState } from "react"
import { X } from "lucide-react"
import { formatZAR } from "@/lib/utils"

type Assessor = { id: string; name: string | null; email: string }

export type DecisionClaim = {
  id: string
  claimNumber: string
  claimAmount: number | string
  insurerRef: string | null
  rejectionReason: string | null
  assessor: Assessor | null
  policy: { sumAssured: number | string; client: { firstName: string; lastName: string } }
}

type Outcome = "approve" | "reject"

const inp = "w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
const lbl = "block text-xs font-semibold text-gray-600 mb-1.5"

const toCents = (rands: number | string) => Math.round(Number(rands) * 100)

/**
 * The lender is an intermediary: the INSURER decides a claim, and staff record
 * that decision here. The approved amount starts empty (a pre-filled figure
 * took the officer's digits on the end of it) and is bounded by the amount
 * claimed and the cover, as the API enforces (app/api/insurance/claims/[id]).
 */
export function ClaimDecisionModal({
  claim,
  advisors,
  onClose,
  onRecorded,
}: {
  claim: DecisionClaim
  advisors: Assessor[]
  onClose: () => void
  onRecorded: () => void
}) {
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [approvedAmount, setApprovedAmount] = useState("")
  const [rejectionReason, setRejectionReason] = useState(claim.rejectionReason ?? "")
  const [assessorId, setAssessorId] = useState(claim.assessor?.id ?? "")
  const [insurerRef, setInsurerRef] = useState(claim.insurerRef ?? "")
  const [error, setError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  const claimedCents = toCents(claim.claimAmount)
  const coverCents = toCents(claim.policy.sumAssured)

  function refusal(): string | null {
    if (!outcome) return "Choose the insurer's decision."
    if (outcome === "reject") return rejectionReason.trim() ? null : "Enter the insurer's reason for declining."
    const amount = Number(approvedAmount)
    if (approvedAmount.trim() === "" || !Number.isFinite(amount) || amount <= 0) return "Enter the amount the insurer approved."
    const cents = toCents(amount)
    if (cents > claimedCents) return `The approved amount cannot exceed the amount claimed (${formatZAR(claimedCents)}).`
    if (cents > coverCents) return `The approved amount cannot exceed the policy's sum assured (${formatZAR(coverCents)}).`
    return null
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const refused = refusal()
    if (refused) {
      setError(refused)
      return
    }
    setProcessing(true)
    setError(null)
    try {
      const res = await fetch(`/api/insurance/claims/${claim.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: outcome,
          ...(outcome === "approve" ? { approvedAmount: Number(approvedAmount) } : { rejectionReason }),
          assessorId: assessorId || undefined,
          insurerRef: insurerRef || undefined,
        }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setError(body.error ?? "The decision could not be recorded.")
        return
      }
      onRecorded()
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setProcessing(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <h2 className="font-bold text-gray-900">Record insurer decision</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="text-gray-400 hover:text-gray-600">
            <X className="h-5 w-5" />
          </button>
        </div>
        <form onSubmit={submit} className="p-6 space-y-4">
          <div className="text-sm text-gray-600">
            <span className="font-semibold">{claim.claimNumber}</span> — {claim.policy.client.firstName} {claim.policy.client.lastName}
            <p className="text-[11px] text-gray-400 mt-1">
              The insurer decides this claim. Record its outcome as the insurer communicated it.
            </p>
          </div>

          {error && (
            <div role="alert" className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">{error}</div>
          )}

          <fieldset className="grid grid-cols-2 gap-2">
            <legend className={lbl}>Insurer&apos;s decision *</legend>
            {([["approve", "Insurer approved"], ["reject", "Insurer declined"]] as const).map(([value, label]) => (
              <label key={value} className={`cursor-pointer rounded-md border px-3 py-2 text-sm ${outcome === value ? "border-[#4F46E5] bg-indigo-50" : "border-gray-200"}`}>
                <input type="radio" name="outcome" value={value} checked={outcome === value} onChange={() => setOutcome(value)} className="mr-2" />
                {label}
              </label>
            ))}
          </fieldset>

          {outcome === "approve" && (
            <div>
              <label className={lbl} htmlFor="approved-amount">Amount the insurer approved (R) *</label>
              <input
                id="approved-amount"
                type="number"
                inputMode="decimal"
                value={approvedAmount}
                onChange={(e) => setApprovedAmount(e.target.value)}
                className={inp}
                placeholder={(claimedCents / 100).toFixed(2)}
                min="0.01"
                step="0.01"
              />
              <p className="text-[11px] text-gray-400 mt-1">
                Claimed: {formatZAR(claimedCents)} · Cover: {formatZAR(coverCents)}
              </p>
            </div>
          )}

          {outcome === "reject" && (
            <div>
              <label className={lbl} htmlFor="decline-reason">Insurer&apos;s reason for declining *</label>
              <textarea
                id="decline-reason"
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                rows={3}
                className={`${inp} resize-none`}
                placeholder="As stated in the insurer's decision"
              />
            </div>
          )}

          <div>
            <label className={lbl} htmlFor="assessor">Assessor</label>
            <select id="assessor" value={assessorId} onChange={(e) => setAssessorId(e.target.value)} className={`${inp} bg-white`}>
              <option value="">— Select assessor —</option>
              {advisors.map((a) => (
                <option key={a.id} value={a.id}>{a.name ?? a.email}</option>
              ))}
            </select>
          </div>

          <div>
            <label className={lbl} htmlFor="insurer-ref">Insurer reference</label>
            <input id="insurer-ref" type="text" value={insurerRef} onChange={(e) => setInsurerRef(e.target.value)} className={inp} placeholder="Insurer claim reference" />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button type="submit" disabled={processing} className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 bg-[#4F46E5] hover:bg-[#4338CA] transition-colors">
              {processing ? "Recording..." : "Record decision"}
            </button>
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
