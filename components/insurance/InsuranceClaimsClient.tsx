"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatZAR, formatDate } from "@/lib/utils"
import Link from "next/link"
import { Plus, X, CheckCircle, XCircle } from "lucide-react"

type Assessor = {
  id: string
  name: string | null
  email: string
}

type Claim = {
  id: string
  claimNumber: string
  status: string
  claimAmount: number | string
  approvedAmount: number | string | null
  submittedAt: Date | string
  resolvedAt: Date | string | null
  notes: string | null
  claimType: string | null
  incidentDate: Date | string | null
  fnolDate: Date | string | null
  insurerRef: string | null
  rejectionReason: string | null
  assessor: Assessor | null
  policy: {
    type: string
    policyNumber: string
    client: { firstName: string; lastName: string; phone: string }
  }
}

const STATUS_COLORS: Record<string, string> = {
  SUBMITTED: "bg-amber-100 text-amber-800",
  UNDER_REVIEW: "bg-blue-100 text-blue-800",
  APPROVED: "bg-green-100 text-green-800",
  REJECTED: "bg-red-100 text-red-800",
  PAID: "bg-teal-100 text-teal-800",
}

const TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER: "Funeral",
  CREDIT_LIFE: "Credit Life",
  LIFE_INSURANCE: "Life",
  SHORT_TERM_MOTOR: "Motor",
  SHORT_TERM_HOME: "Home",
}

const ALL_STATUSES = ["ALL", "SUBMITTED", "UNDER_REVIEW", "APPROVED", "PAID", "REJECTED"]

type AdjudicationModal =
  | { type: "approve"; claim: Claim }
  | { type: "reject"; claim: Claim }
  | null

export function InsuranceClaimsClient({
  claims,
  advisors = [],
}: {
  claims: Claim[]
  advisors?: Assessor[]
}) {
  const router = useRouter()
  const [filter, setFilter] = useState("ALL")
  const [modal, setModal] = useState<AdjudicationModal>(null)
  const [processing, setProcessing] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)

  // Approve form
  const [approvedAmount, setApprovedAmount] = useState("")
  const [assessorId, setAssessorId] = useState("")
  const [insurerRef, setInsurerRef] = useState("")

  // Reject form
  const [rejectionReason, setRejectionReason] = useState("")

  const filtered = filter === "ALL" ? claims : claims.filter((c) => c.status === filter)

  const openApprove = (claim: Claim) => {
    setModal({ type: "approve", claim })
    setApprovedAmount(String(Number(claim.claimAmount)))
    setAssessorId(claim.assessor?.id ?? "")
    setInsurerRef(claim.insurerRef ?? "")
    setModalError(null)
  }

  const openReject = (claim: Claim) => {
    setModal({ type: "reject", claim })
    setRejectionReason(claim.rejectionReason ?? "")
    setAssessorId(claim.assessor?.id ?? "")
    setInsurerRef(claim.insurerRef ?? "")
    setModalError(null)
  }

  const closeModal = () => {
    setModal(null)
    setModalError(null)
  }

  const handleApprove = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!modal || modal.type !== "approve") return
    if (!approvedAmount || isNaN(parseFloat(approvedAmount))) {
      setModalError("A valid approved amount is required.")
      return
    }
    setProcessing(true)
    setModalError(null)
    try {
      const res = await fetch(`/api/insurance/claims/${modal.claim.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve",
          approvedAmount: parseFloat(approvedAmount),
          assessorId: assessorId || undefined,
          insurerRef: insurerRef || undefined,
        }),
      })
      if (!res.ok) throw new Error("Failed to approve claim")
      closeModal()
      router.refresh()
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setProcessing(false)
    }
  }

  const handleReject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!modal || modal.type !== "reject") return
    if (!rejectionReason.trim()) {
      setModalError("A rejection reason is required.")
      return
    }
    setProcessing(true)
    setModalError(null)
    try {
      const res = await fetch(`/api/insurance/claims/${modal.claim.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reject",
          rejectionReason,
          assessorId: assessorId || undefined,
          insurerRef: insurerRef || undefined,
        }),
      })
      if (!res.ok) throw new Error("Failed to reject claim")
      closeModal()
      router.refresh()
    } catch (err) {
      setModalError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setProcessing(false)
    }
  }

  const canAdjudicate = (status: string) =>
    status === "SUBMITTED" || status === "UNDER_REVIEW"

  const inp = "w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1b1d24]">Insurance Claims</h1>
          <p className="text-sm text-gray-500 mt-1">{claims.length} total claims</p>
        </div>
        <Link
          href="/insurance"
          className="flex items-center gap-2 px-4 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA]"
        >
          <Plus className="h-4 w-4" /> New Claim
        </Link>
      </div>

      {/* Status filter tabs */}
      <div className="flex gap-1 mb-4 bg-white rounded-xl p-1 shadow-sm w-fit">
        {ALL_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
              filter === s ? "bg-[#4F46E5] text-white" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {s.replace("_", " ")}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              <th className="px-4 py-3 text-left">Claim No</th>
              <th className="px-4 py-3 text-left">Client</th>
              <th className="px-4 py-3 text-left">Policy Type</th>
              <th className="px-4 py-3 text-left">Claim Type</th>
              <th className="px-4 py-3 text-left">Status</th>
              <th className="px-4 py-3 text-right">Claim Amount</th>
              <th className="px-4 py-3 text-right">Approved</th>
              <th className="px-4 py-3 text-left">Insurer Ref</th>
              <th className="px-4 py-3 text-left">Submitted</th>
              <th className="px-4 py-3 text-left">Resolved</th>
              <th className="px-4 py-3 text-left">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {filtered.map((c) => (
              <tr key={c.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-mono text-xs text-[#4F46E5]">{c.claimNumber}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">
                    {c.policy.client.firstName} {c.policy.client.lastName}
                  </div>
                  <div className="text-[10px] text-gray-400">{c.policy.client.phone}</div>
                </td>
                <td className="px-4 py-3 text-gray-600">{TYPE_LABELS[c.policy.type] || c.policy.type}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{c.claimType ?? "—"}</td>
                <td className="px-4 py-3">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${STATUS_COLORS[c.status] || "bg-gray-100"}`}>
                    {c.status.replace("_", " ")}
                  </span>
                </td>
                <td className="px-4 py-3 text-right font-semibold">
                  {formatZAR(Number(c.claimAmount) * 100)}
                </td>
                <td className="px-4 py-3 text-right text-gray-600">
                  {c.approvedAmount ? formatZAR(Number(c.approvedAmount) * 100) : "—"}
                </td>
                <td className="px-4 py-3 text-gray-500 text-xs">{c.insurerRef ?? "—"}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">{formatDate(c.submittedAt)}</td>
                <td className="px-4 py-3 text-gray-500 text-xs">
                  {c.resolvedAt ? formatDate(c.resolvedAt) : "—"}
                </td>
                <td className="px-4 py-3">
                  {canAdjudicate(c.status) && (
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => openApprove(c)}
                        className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded border border-green-200 text-green-700 hover:bg-green-50 transition-colors"
                      >
                        <CheckCircle className="h-3 w-3" /> Approve
                      </button>
                      <button
                        onClick={() => openReject(c)}
                        className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                      >
                        <XCircle className="h-3 w-3" /> Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={11} className="px-4 py-8 text-center text-gray-400">
                  No claims found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Approve Modal */}
      {modal?.type === "approve" && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900 flex items-center gap-2">
                <CheckCircle className="h-5 w-5 text-green-600" /> Approve Claim
              </h2>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleApprove} className="p-6 space-y-4">
              <div className="text-sm text-gray-600">
                <span className="font-semibold">{modal.claim.claimNumber}</span> —{" "}
                {modal.claim.policy.client.firstName} {modal.claim.policy.client.lastName}
              </div>

              {modalError && (
                <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
                  {modalError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">
                  Approved Amount (R) *
                </label>
                <input
                  type="number"
                  value={approvedAmount}
                  onChange={(e) => setApprovedAmount(e.target.value)}
                  className={inp}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  required
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Claimed: {formatZAR(Number(modal.claim.claimAmount) * 100)}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Assessor</label>
                <select
                  value={assessorId}
                  onChange={(e) => setAssessorId(e.target.value)}
                  className={`${inp} bg-white`}
                >
                  <option value="">— Select assessor —</option>
                  {advisors.map((a) => (
                    <option key={a.id} value={a.id}>{a.name ?? a.email}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Insurer Reference</label>
                <input
                  type="text"
                  value={insurerRef}
                  onChange={(e) => setInsurerRef(e.target.value)}
                  className={inp}
                  placeholder="Insurer claim reference"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={processing}
                  className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 bg-green-600 hover:bg-green-700 transition-colors"
                >
                  {processing ? "Approving..." : "Approve Claim"}
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reject Modal */}
      {modal?.type === "reject" && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900 flex items-center gap-2">
                <XCircle className="h-5 w-5 text-red-600" /> Reject Claim
              </h2>
              <button onClick={closeModal} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleReject} className="p-6 space-y-4">
              <div className="text-sm text-gray-600">
                <span className="font-semibold">{modal.claim.claimNumber}</span> —{" "}
                {modal.claim.policy.client.firstName} {modal.claim.policy.client.lastName}
              </div>

              {modalError && (
                <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
                  {modalError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">
                  Rejection Reason *
                </label>
                <textarea
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  rows={3}
                  required
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
                  placeholder="Reason for rejecting this claim..."
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Assessor</label>
                <select
                  value={assessorId}
                  onChange={(e) => setAssessorId(e.target.value)}
                  className={`${inp} bg-white`}
                >
                  <option value="">— Select assessor —</option>
                  {advisors.map((a) => (
                    <option key={a.id} value={a.id}>{a.name ?? a.email}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Insurer Reference</label>
                <input
                  type="text"
                  value={insurerRef}
                  onChange={(e) => setInsurerRef(e.target.value)}
                  className={inp}
                  placeholder="Insurer claim reference"
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={processing}
                  className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 bg-red-600 hover:bg-red-700 transition-colors"
                >
                  {processing ? "Rejecting..." : "Reject Claim"}
                </button>
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
