"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { formatZAR, formatDate } from "@/lib/utils"
import Link from "next/link"
import { ClipboardCheck, Plus } from "lucide-react"
import { ClaimDecisionModal } from "./ClaimDecisionModal"

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
    sumAssured: number | string
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

export function InsuranceClaimsClient({
  claims,
  advisors = [],
}: {
  claims: Claim[]
  advisors?: Assessor[]
}) {
  const router = useRouter()
  const [filter, setFilter] = useState("ALL")
  const [deciding, setDeciding] = useState<Claim | null>(null)

  const filtered = filter === "ALL" ? claims : claims.filter((c) => c.status === filter)

  // The insurer paid an APPROVED claim (the API's "mark_paid", audited).
  const [paying, setPaying] = useState<string | null>(null)
  const [payError, setPayError] = useState<{ id: string; message: string } | null>(null)
  async function recordPaid(claim: Claim) {
    setPaying(claim.id)
    setPayError(null)
    try {
      const res = await fetch(`/api/insurance/claims/${claim.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_paid" }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setPayError({ id: claim.id, message: body.error ?? "The payment could not be recorded." })
        return
      }
      router.refresh()
    } catch {
      setPayError({ id: claim.id, message: "Network error. Please try again." })
    } finally {
      setPaying(null)
    }
  }

  const canAdjudicate = (status: string) =>
    status === "SUBMITTED" || status === "UNDER_REVIEW"

  return (
    <div>
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1b1d24]">Insurance Claims</h1>
          <p className="text-sm text-gray-500 mt-1">{claims.length} total claims</p>
        </div>
        <Link
          href="/insurance/claims/new"
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
                    <button
                      onClick={() => setDeciding(c)}
                      className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded border border-gray-200 text-[#4F46E5] hover:bg-indigo-50 transition-colors whitespace-nowrap"
                    >
                      <ClipboardCheck className="h-3 w-3" /> Record insurer decision
                    </button>
                  )}
                  {c.status === "APPROVED" && (
                    <button
                      onClick={() => recordPaid(c)}
                      disabled={paying === c.id}
                      className="flex items-center gap-1 text-[11px] font-medium px-2 py-1 rounded border border-gray-200 text-[#4F46E5] hover:bg-indigo-50 transition-colors whitespace-nowrap disabled:opacity-60"
                    >
                      <ClipboardCheck className="h-3 w-3" /> {paying === c.id ? "Recording..." : "Record insurer payment"}
                    </button>
                  )}
                  {payError?.id === c.id && <p role="alert" className="mt-1 text-[11px] text-red-600">{payError.message}</p>}
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

      {deciding && (
        <ClaimDecisionModal
          claim={deciding}
          advisors={advisors}
          onClose={() => setDeciding(null)}
          onRecorded={() => {
            setDeciding(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}
