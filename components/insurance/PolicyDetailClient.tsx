"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { formatDate, formatZAR } from "@/lib/utils"
import { Plus, Trash2, X, Ban } from "lucide-react"

type Client = {
  id: string
  firstName: string
  lastName: string
  idNumber: string
  phone: string
  email: string | null
}

type Claim = {
  id: string
  claimNumber: string
  status: string
  claimAmount: number
  approvedAmount: number | null
  submittedAt: Date | string
  resolvedAt: Date | string | null
  notes: string | null
}

type PremiumPayment = {
  id: string
  amount: number
  dueDate: Date | string
  paidDate: Date | string | null
  status: string
}

type Beneficiary = {
  id: string
  firstName: string
  lastName: string
  idNumber: string | null
  dateOfBirth: Date | string | null
  relationship: string
  coverAmount: number | null
}

type Policy = {
  id: string
  policyNumber: string
  type: string
  status: string
  premiumAmount: number
  sumAssured: number
  commissionRate: number
  commissionAmount: number | null
  startDate: Date | string
  renewalDate: Date | string
  insurer: string | null
  pprIssuedAt: Date | string | null
  pprAcknowledgedAt: Date | string | null
  pprAcknowledgedBy: string | null
  client: Client
  claims: Claim[]
  premiumPayments: PremiumPayment[]
  beneficiaries: Beneficiary[]
}

const TYPE_LABELS: Record<string, string> = {
  FUNERAL_COVER: "Funeral Cover",
  CREDIT_LIFE: "Credit Life",
  LIFE_INSURANCE: "Life Insurance",
  SHORT_TERM_MOTOR: "Short-term Motor",
  SHORT_TERM_HOME: "Short-term Home",
  SHORT_TERM_CONTENTS: "Short-term Contents",
  BUSINESS_INSURANCE: "Business Insurance",
}

const STATUS_COLORS: Record<string, string> = {
  ACTIVE: "bg-green-100 text-green-800",
  LAPSED: "bg-red-100 text-red-800",
  CANCELLED: "bg-gray-100 text-gray-600",
  CLAIMED: "bg-blue-100 text-blue-800",
}

const CLAIM_STATUS_COLORS: Record<string, string> = {
  SUBMITTED: "bg-amber-100 text-amber-800",
  UNDER_REVIEW: "bg-blue-100 text-blue-800",
  APPROVED: "bg-green-100 text-green-800",
  REJECTED: "bg-red-100 text-red-800",
  PAID: "bg-teal-100 text-teal-800",
}

const PREMIUM_STATUS_COLORS: Record<string, string> = {
  DUE: "bg-amber-100 text-amber-800",
  PAID: "bg-green-100 text-green-800",
  OVERDUE: "bg-red-100 text-red-800",
  WAIVED: "bg-gray-100 text-gray-600",
}

const RELATIONSHIPS = ["SPOUSE", "CHILD", "PARENT", "SIBLING", "OTHER"]

type Tab = "overview" | "beneficiaries" | "claims" | "premiums"

const BLANK_BENEFICIARY_FORM = {
  firstName: "",
  lastName: "",
  idNumber: "",
  dateOfBirth: "",
  relationship: "SPOUSE",
  coverAmount: "",
}

export function PolicyDetailClient({ policy }: { policy: Policy }) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<Tab>("overview")
  const [showAddBeneficiary, setShowAddBeneficiary] = useState(false)
  const [beneficiaryForm, setBeneficiaryForm] = useState(BLANK_BENEFICIARY_FORM)
  const [savingBeneficiary, setSavingBeneficiary] = useState(false)
  const [beneficiaryError, setBeneficiaryError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Cancel policy modal
  const [showCancelModal, setShowCancelModal] = useState(false)
  const [cancelReason, setCancelReason] = useState("")
  const [cancelDate, setCancelDate] = useState(new Date().toISOString().slice(0, 10))
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [cancelPreview, setCancelPreview] = useState<{ refundAmount: number } | null>(null)

  const computeRefundPreview = (dateStr: string) => {
    const cancellationDate = new Date(dateStr)
    const startDate = new Date(policy.startDate)
    const renewalDate = new Date(policy.renewalDate)
    const totalPolicyDays = Math.max(1, Math.round((renewalDate.getTime() - startDate.getTime()) / 86400000))
    const daysRemaining = Math.max(0, Math.round((renewalDate.getTime() - cancellationDate.getTime()) / 86400000))
    const annualPremium = Number(policy.premiumAmount) * 12
    const refundAmount = parseFloat(((daysRemaining / totalPolicyDays) * annualPremium).toFixed(2))
    setCancelPreview({ refundAmount })
  }

  const handleCancelDateChange = (d: string) => {
    setCancelDate(d)
    computeRefundPreview(d)
  }

  const openCancelModal = () => {
    setCancelReason("")
    setCancelDate(new Date().toISOString().slice(0, 10))
    setCancelError(null)
    computeRefundPreview(new Date().toISOString().slice(0, 10))
    setShowCancelModal(true)
  }

  const handleCancelPolicy = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!cancelReason.trim()) {
      setCancelError("A cancellation reason is required.")
      return
    }
    setCancelling(true)
    setCancelError(null)
    try {
      const res = await fetch(`/api/insurance/policies/${policy.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: cancelReason, cancellationDate: cancelDate }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to cancel policy")
      setShowCancelModal(false)
      router.refresh()
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setCancelling(false)
    }
  }

  const setField = (field: string, value: string) =>
    setBeneficiaryForm((f) => ({ ...f, [field]: value }))

  const handleAddBeneficiary = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!beneficiaryForm.firstName || !beneficiaryForm.lastName || !beneficiaryForm.relationship) {
      setBeneficiaryError("First name, last name, and relationship are required.")
      return
    }
    setSavingBeneficiary(true)
    setBeneficiaryError(null)
    try {
      const res = await fetch(`/api/insurance/policies/${policy.id}/beneficiaries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName: beneficiaryForm.firstName,
          lastName: beneficiaryForm.lastName,
          idNumber: beneficiaryForm.idNumber || undefined,
          dateOfBirth: beneficiaryForm.dateOfBirth || undefined,
          relationship: beneficiaryForm.relationship,
          coverAmount: beneficiaryForm.coverAmount
            ? parseFloat(beneficiaryForm.coverAmount)
            : undefined,
        }),
      })
      if (!res.ok) throw new Error("Failed to add beneficiary")
      setShowAddBeneficiary(false)
      setBeneficiaryForm(BLANK_BENEFICIARY_FORM)
      router.refresh()
    } catch (err) {
      setBeneficiaryError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setSavingBeneficiary(false)
    }
  }

  const handleDeleteBeneficiary = async (beneficiaryId: string) => {
    if (!confirm("Remove this beneficiary?")) return
    setDeletingId(beneficiaryId)
    try {
      await fetch(`/api/insurance/policies/${policy.id}/beneficiaries/${beneficiaryId}`, {
        method: "DELETE",
      })
      router.refresh()
    } finally {
      setDeletingId(null)
    }
  }

  const inp = "w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-[#1b1d24]">{policy.policyNumber}</h1>
            <span className={`text-[11px] font-semibold px-2.5 py-0.5 rounded-full ${STATUS_COLORS[policy.status] ?? "bg-gray-100 text-gray-600"}`}>
              {policy.status}
            </span>
          </div>
          <p className="text-sm text-gray-500 mt-1">
            {TYPE_LABELS[policy.type] ?? policy.type}
            {policy.insurer && <span className="text-gray-400"> · {policy.insurer}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {policy.status !== "CANCELLED" && policy.status !== "LAPSED" && (
            <button
              onClick={openCancelModal}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm font-medium hover:bg-red-50 transition-colors"
            >
              <Ban className="h-4 w-4" /> Cancel Policy
            </button>
          )}
          <Link href="/insurance" className="text-sm text-gray-500 hover:text-gray-700">
            ← Insurance
          </Link>
        </div>
      </div>

      {/* PPR / Product Disclosure Warning */}
      {!policy.pprIssuedAt && policy.status === "PENDING" && (
        <div className="mb-5 flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <div className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full bg-amber-400 flex items-center justify-center">
            <span className="text-white text-[11px] font-bold">!</span>
          </div>
          <div>
            <p className="text-sm font-semibold text-amber-800">PPR / Product Disclosure not yet issued</p>
            <p className="text-[12px] text-amber-700 mt-0.5">
              This policy cannot be activated until the product disclosure document has been issued to the client.
              Record the PPR issuance before changing the status to Active.
            </p>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-5 bg-gray-100 p-1 rounded-lg w-fit">
        {(["overview", "beneficiaries", "claims", "premiums"] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded-md text-[12px] font-semibold capitalize transition-colors ${
              activeTab === tab ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
            }`}
          >
            {tab}
            {tab === "beneficiaries" && (
              <span className="ml-1.5 text-[10px] text-gray-400">{policy.beneficiaries.length}</span>
            )}
            {tab === "claims" && (
              <span className="ml-1.5 text-[10px] text-gray-400">{policy.claims.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Policy details */}
          <div className="bg-white rounded-xl shadow-sm p-5 space-y-3">
            <h2 className="font-bold text-[#1b1d24] mb-3">Policy Details</h2>
            {[
              { label: "Policy Type", value: TYPE_LABELS[policy.type] ?? policy.type },
              { label: "Insurer", value: policy.insurer ?? "—" },
              { label: "Start Date", value: formatDate(policy.startDate) },
              { label: "Renewal Date", value: formatDate(policy.renewalDate) },
              { label: "Sum Assured", value: <span className="whitespace-nowrap">{formatZAR(policy.sumAssured * 100)}</span> },
              { label: "Monthly Premium", value: <span className="whitespace-nowrap">{formatZAR(policy.premiumAmount * 100)}</span> },
              { label: "Commission Rate", value: `${(policy.commissionRate * 100).toFixed(1)}%` },
              {
                label: "Commission Amount",
                value: policy.commissionAmount ? <span className="whitespace-nowrap">{formatZAR(policy.commissionAmount * 100)}</span> : "—",
              },
              {
                label: "PPR Issued",
                value: policy.pprIssuedAt ? formatDate(policy.pprIssuedAt) : "Not yet issued",
              },
              {
                label: "PPR Acknowledged",
                value: policy.pprAcknowledgedAt
                  ? `${formatDate(policy.pprAcknowledgedAt)}${policy.pprAcknowledgedBy ? ` — ${policy.pprAcknowledgedBy}` : ""}`
                  : "—",
              },
            ].map((row) => (
              <div key={row.label} className="flex justify-between text-sm border-b border-gray-50 pb-2 last:border-0 last:pb-0">
                <span className="text-gray-400 text-xs">{row.label}</span>
                <span className={`font-medium text-xs ${row.label === "PPR Issued" && !policy.pprIssuedAt ? "text-amber-600" : "text-[#1b1d24]"}`}>
                  {row.value}
                </span>
              </div>
            ))}
          </div>

          {/* Client details */}
          <div className="bg-white rounded-xl shadow-sm p-5 space-y-3">
            <h2 className="font-bold text-[#1b1d24] mb-3">Policyholder</h2>
            {[
              { label: "Full Name", value: `${policy.client.firstName} ${policy.client.lastName}` },
              { label: "ID Number", value: policy.client.idNumber },
              { label: "Phone", value: policy.client.phone },
              { label: "Email", value: policy.client.email ?? "—" },
            ].map((row) => (
              <div key={row.label} className="flex justify-between text-sm border-b border-gray-50 pb-2 last:border-0 last:pb-0">
                <span className="text-gray-400 text-xs">{row.label}</span>
                <span className="font-medium text-[#1b1d24] text-xs">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Beneficiaries Tab */}
      {activeTab === "beneficiaries" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-bold text-[#1b1d24]">
              Lives / Beneficiaries
              <span className="ml-2 text-sm font-normal text-gray-400">({policy.beneficiaries.length})</span>
            </h2>
            <button
              onClick={() => { setShowAddBeneficiary(true); setBeneficiaryError(null) }}
              className="flex items-center gap-2 px-4 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA] transition-colors"
            >
              <Plus className="h-4 w-4" /> Add Beneficiary
            </button>
          </div>

          <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
                  {["Name", "ID Number", "Date of Birth", "Relationship", "Cover Amount", ""].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {policy.beneficiaries.map((b, i) => (
                  <tr
                    key={b.id}
                    className="border-b border-gray-50"
                    style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}
                  >
                    <td className="px-4 py-3.5">
                      <span className="font-semibold text-[13px] text-gray-900">
                        {b.firstName} {b.lastName}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-gray-500">{b.idNumber ?? "—"}</td>
                    <td className="px-4 py-3.5 text-[13px] text-gray-600">
                      {b.dateOfBirth ? formatDate(b.dateOfBirth) : "—"}
                    </td>
                    <td className="px-4 py-3.5 text-[13px] text-gray-600">
                      {b.relationship.charAt(0) + b.relationship.slice(1).toLowerCase()}
                    </td>
                    <td className="px-4 py-3.5 text-[13px] text-gray-600">
                      {b.coverAmount != null ? formatZAR(b.coverAmount * 100) : "—"}
                    </td>
                    <td className="px-4 py-3.5">
                      <button
                        onClick={() => handleDeleteBeneficiary(b.id)}
                        disabled={deletingId === b.id}
                        className="text-red-400 hover:text-red-600 transition-colors disabled:opacity-50"
                        title="Remove beneficiary"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {policy.beneficiaries.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-gray-400 text-sm">
                      No beneficiaries added yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Add Beneficiary Modal */}
          {showAddBeneficiary && (
            <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
              <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
                <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
                  <h2 className="font-bold text-gray-900">Add Beneficiary / Life</h2>
                  <button onClick={() => setShowAddBeneficiary(false)} className="text-gray-400 hover:text-gray-600">
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <form onSubmit={handleAddBeneficiary} className="p-6 space-y-4">
                  {beneficiaryError && (
                    <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
                      {beneficiaryError}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 mb-1.5">First Name *</label>
                      <input
                        type="text"
                        value={beneficiaryForm.firstName}
                        onChange={(e) => setField("firstName", e.target.value)}
                        className={inp}
                        placeholder="First name"
                        required
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 mb-1.5">Last Name *</label>
                      <input
                        type="text"
                        value={beneficiaryForm.lastName}
                        onChange={(e) => setField("lastName", e.target.value)}
                        className={inp}
                        placeholder="Last name"
                        required
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 mb-1.5">ID Number</label>
                      <input
                        type="text"
                        value={beneficiaryForm.idNumber}
                        onChange={(e) => setField("idNumber", e.target.value)}
                        className={inp}
                        placeholder="SA ID number"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 mb-1.5">Date of Birth</label>
                      <input
                        type="date"
                        value={beneficiaryForm.dateOfBirth}
                        onChange={(e) => setField("dateOfBirth", e.target.value)}
                        className={inp}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 mb-1.5">Relationship *</label>
                      <select
                        value={beneficiaryForm.relationship}
                        onChange={(e) => setField("relationship", e.target.value)}
                        className={`${inp} bg-white`}
                        required
                      >
                        {RELATIONSHIPS.map((r) => (
                          <option key={r} value={r}>
                            {r.charAt(0) + r.slice(1).toLowerCase()}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-gray-600 mb-1.5">Cover Amount (R)</label>
                      <input
                        type="number"
                        value={beneficiaryForm.coverAmount}
                        onChange={(e) => setField("coverAmount", e.target.value)}
                        className={inp}
                        placeholder="0.00"
                        min="0"
                        step="0.01"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-3 pt-2">
                    <button
                      type="submit"
                      disabled={savingBeneficiary}
                      className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60"
                      style={{ backgroundColor: "#4338CA" }}
                    >
                      {savingBeneficiary ? "Saving..." : "Add Beneficiary"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAddBeneficiary(false)}
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
      )}

      {/* Claims Tab */}
      {activeTab === "claims" && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
                {["Claim #", "Status", "Claim Amount", "Approved Amount", "Submitted", "Resolved", "Notes"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {policy.claims.map((c, i) => (
                <tr
                  key={c.id}
                  className="border-b border-gray-50"
                  style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}
                >
                  <td className="px-4 py-3.5 font-mono text-xs text-[#4F46E5]">{c.claimNumber}</td>
                  <td className="px-4 py-3.5">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${CLAIM_STATUS_COLORS[c.status] ?? "bg-gray-100 text-gray-600"}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-[13px]">{formatZAR(c.claimAmount * 100)}</td>
                  <td className="px-4 py-3.5 text-[13px]">
                    {c.approvedAmount != null ? formatZAR(c.approvedAmount * 100) : "—"}
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-600">{formatDate(c.submittedAt)}</td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-600">
                    {c.resolvedAt ? formatDate(c.resolvedAt) : "—"}
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-500">{c.notes ?? "—"}</td>
                </tr>
              ))}
              {policy.claims.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-gray-400 text-sm">
                    No claims on this policy
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Premiums Tab */}
      {activeTab === "premiums" && (
        <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
                {["Due Date", "Amount", "Status", "Paid Date"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {policy.premiumPayments.map((p, i) => (
                <tr
                  key={p.id}
                  className="border-b border-gray-50"
                  style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}
                >
                  <td className="px-4 py-3.5 text-[13px] text-gray-700">{formatDate(p.dueDate)}</td>
                  <td className="px-4 py-3.5 text-[13px] font-semibold">{formatZAR(p.amount * 100)}</td>
                  <td className="px-4 py-3.5">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${PREMIUM_STATUS_COLORS[p.status] ?? "bg-gray-100 text-gray-600"}`}>
                      {p.status}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-600">
                    {p.paidDate ? formatDate(p.paidDate) : "—"}
                  </td>
                </tr>
              ))}
              {policy.premiumPayments.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-gray-400 text-sm">
                    No premium schedule generated
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Cancel Policy Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900 flex items-center gap-2">
                <Ban className="h-5 w-5 text-red-600" /> Cancel Policy
              </h2>
              <button onClick={() => setShowCancelModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCancelPolicy} className="p-6 space-y-4">
              <div className="text-sm text-gray-600">
                Cancelling <span className="font-semibold">{policy.policyNumber}</span>
              </div>

              {cancelError && (
                <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
                  {cancelError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Cancellation Date *</label>
                <input
                  type="date"
                  value={cancelDate}
                  onChange={(e) => handleCancelDateChange(e.target.value)}
                  className={inp}
                  required
                />
              </div>

              {cancelPreview && (
                <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm">
                  <p className="font-semibold text-amber-800">Estimated pro-rata refund</p>
                  <p className="text-2xl font-extrabold text-[#4F46E5] mt-1">
                    {formatZAR(cancelPreview.refundAmount * 100)}
                  </p>
                  <p className="text-[11px] text-amber-700 mt-1">
                    Based on (days remaining / policy days) × annual premium
                  </p>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Reason *</label>
                <textarea
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  rows={3}
                  required
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
                  placeholder="Reason for cancellation..."
                />
              </div>

              <div className="bg-red-50 border border-red-100 rounded-md px-4 py-3 text-sm text-red-700">
                This action cannot be undone. Any pending commissions for this policy will be clawed back.
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={cancelling}
                  className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 bg-red-600 hover:bg-red-700 transition-colors"
                >
                  {cancelling ? "Cancelling..." : "Confirm Cancellation"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCancelModal(false)}
                  className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Keep Policy
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
