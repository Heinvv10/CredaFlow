"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { formatDate } from "@/lib/utils"
import { Plus, X, AlertTriangle } from "lucide-react"
import { DsarDecisionRecordsButton } from "./DsarDecisionRecordsButton"

type ClientOption = {
  id: string
  firstName: string
  lastName: string
  idNumber: string
}

type Client = {
  id: string
  firstName: string
  lastName: string
  idNumber: string
  email: string | null
}

type Dsar = {
  id: string
  reference: string
  clientId: string
  type: string
  description: string | null
  status: string
  dueDate: Date | string
  completedAt: Date | string | null
  response: string | null
  createdAt: Date | string
  client: Client
}

const TYPE_LABELS: Record<string, string> = {
  ACCESS: "Access",
  CORRECTION: "Correction",
  DELETION: "Deletion",
  OBJECTION: "Objection",
  PORTABILITY: "Portability",
}

const STATUS_LABELS: Record<string, string> = {
  RECEIVED: "Received",
  IN_PROGRESS: "In Progress",
  COMPLETED: "Completed",
  OVERDUE: "Overdue",
  REFUSED: "Refused",
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  RECEIVED: { bg: "#DBEAFE", text: "#1E40AF" },
  IN_PROGRESS: { bg: "#FEF3C7", text: "#92400E" },
  COMPLETED: { bg: "#D1FAE5", text: "#065F46" },
  OVERDUE: { bg: "#FEE2E2", text: "#991B1B" },
  REFUSED: { bg: "#F3F4F6", text: "#374151" },
}

const NEXT_STATUS: Record<string, string[]> = {
  RECEIVED: ["IN_PROGRESS", "REFUSED"],
  IN_PROGRESS: ["COMPLETED", "REFUSED"],
  COMPLETED: [],
  OVERDUE: ["IN_PROGRESS", "COMPLETED", "REFUSED"],
  REFUSED: [],
}

const DSAR_TYPES = Object.keys(TYPE_LABELS)

function daysUntilDue(dueDate: Date | string) {
  return Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86400000)
}

function isOverdue(dsar: Dsar) {
  if (dsar.status === "COMPLETED" || dsar.status === "REFUSED") return false
  return new Date(dsar.dueDate) < new Date()
}

export function DsarClient({
  dsars,
  clients,
}: {
  dsars: Dsar[]
  clients: ClientOption[]
}) {
  const router = useRouter()
  const [showNewModal, setShowNewModal] = useState(false)
  const [selectedDsar, setSelectedDsar] = useState<Dsar | null>(null)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [newForm, setNewForm] = useState({ clientId: "", type: "ACCESS", description: "" })
  const [newLoading, setNewLoading] = useState(false)
  const [newError, setNewError] = useState<string | null>(null)

  const [updateStatus, setUpdateStatus] = useState("")
  const [response, setResponse] = useState("")

  const stats = {
    total: dsars.length,
    inProgress: dsars.filter((d) => d.status === "RECEIVED" || d.status === "IN_PROGRESS").length,
    overdue: dsars.filter((d) => isOverdue(d)).length,
    completed: dsars.filter((d) => d.status === "COMPLETED").length,
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newForm.clientId) {
      setNewError("Client is required.")
      return
    }
    setNewLoading(true)
    setNewError(null)
    try {
      const res = await fetch("/api/dsar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: newForm.clientId,
          type: newForm.type,
          description: newForm.description || undefined,
        }),
      })
      if (!res.ok) throw new Error("Failed to create DSAR")
      setShowNewModal(false)
      setNewForm({ clientId: "", type: "ACCESS", description: "" })
      router.refresh()
    } catch (err) {
      setNewError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setNewLoading(false)
    }
  }

  const handleStatusUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedDsar || !updateStatus) return
    setUpdating(true)
    setError(null)
    try {
      const body: Record<string, string> = { status: updateStatus }
      if (response) body.response = response
      const res = await fetch(`/api/dsar/${selectedDsar.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error("Failed to update DSAR")
      setSelectedDsar(null)
      setUpdateStatus("")
      setResponse("")
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1b1d24]">DSAR Management</h1>
          <p className="text-sm text-gray-500 mt-1">POPIA Data Subject Access Requests — 30-day response deadline</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/compliance" className="text-sm text-gray-500 hover:text-gray-700">
            ← Compliance
          </Link>
          <button
            onClick={() => setShowNewModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA] transition-colors"
          >
            <Plus className="h-4 w-4" /> New DSAR
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total", value: stats.total, color: "#1565c0" },
          { label: "In Progress", value: stats.inProgress, color: "#92400E" },
          { label: "Overdue", value: stats.overdue, color: "#991B1B" },
          { label: "Completed", value: stats.completed, color: "#065F46" },
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
              {["Request Ref", "Client", "Request Type", "Date Received", "Due Date", "Status", "Days Remaining", "Actions"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dsars.map((d, i) => {
              const sc = STATUS_COLORS[d.status] ?? { bg: "#F3F4F6", text: "#374151" }
              const daysLeft = daysUntilDue(d.dueDate)
              const overdue = isOverdue(d)
              return (
                <tr
                  key={d.id}
                  className="border-b border-gray-50 hover:bg-gray-50 transition-colors"
                  style={{ backgroundColor: overdue ? "#FFF5F5" : i % 2 === 0 ? "#FFF" : "#FAFAFA" }}
                >
                  <td className="px-4 py-3.5">
                    <span className="font-mono text-xs text-gray-500">{d.reference}</span>
                  </td>
                  <td className="px-4 py-3.5">
                    <p className="font-semibold text-gray-900 text-[13px]">
                      {d.client.firstName} {d.client.lastName}
                    </p>
                    <p className="text-[11px] text-gray-400">{d.client.idNumber}</p>
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-700">
                    {TYPE_LABELS[d.type] ?? d.type}
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-600">
                    {formatDate(d.createdAt)}
                  </td>
                  <td className="px-4 py-3.5 text-[13px]">
                    <span className={overdue ? "text-red-600 font-semibold" : "text-gray-600"}>
                      {formatDate(d.dueDate)}
                    </span>
                  </td>
                  <td className="px-4 py-3.5">
                    <span
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[11px] font-semibold"
                      style={{ backgroundColor: sc.bg, color: sc.text }}
                    >
                      {overdue && d.status !== "COMPLETED" && d.status !== "REFUSED" && (
                        <AlertTriangle className="h-3 w-3" />
                      )}
                      {STATUS_LABELS[d.status] ?? d.status}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-[13px]">
                    {d.status === "COMPLETED" || d.status === "REFUSED" ? (
                      <span className="text-gray-400">—</span>
                    ) : overdue ? (
                      <span className="text-red-600 font-semibold">{Math.abs(daysLeft)}d overdue</span>
                    ) : (
                      <span className={daysLeft <= 5 ? "text-orange-600 font-semibold" : "text-gray-600"}>
                        {daysLeft}d left
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3.5 space-y-1.5">
                    <DsarDecisionRecordsButton dsarId={d.id} reference={d.reference} />
                    {NEXT_STATUS[d.status]?.length > 0 && (
                      <button
                        onClick={() => {
                          setSelectedDsar(d)
                          setUpdateStatus(NEXT_STATUS[d.status][0])
                          setResponse(d.response ?? "")
                          setError(null)
                        }}
                        className="text-[11px] font-medium px-2.5 py-1 rounded border border-gray-200 hover:border-[#4338CA] hover:text-[#4F46E5] transition-colors"
                      >
                        Update
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {dsars.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-12 text-center text-gray-400 text-sm">
                  No data subject requests found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* New DSAR Modal */}
      {showNewModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900">New Data Subject Request</h2>
              <button onClick={() => setShowNewModal(false)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleCreate} className="p-6 space-y-4">
              {newError && (
                <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
                  {newError}
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Client *</label>
                <select
                  value={newForm.clientId}
                  onChange={(e) => setNewForm((f) => ({ ...f, clientId: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] bg-white"
                  required
                >
                  <option value="">— Select client —</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.firstName} {c.lastName} ({c.idNumber})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Request Type *</label>
                <select
                  value={newForm.type}
                  onChange={(e) => setNewForm((f) => ({ ...f, type: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] bg-white"
                >
                  {DSAR_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABELS[t]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Notes / Description</label>
                <textarea
                  value={newForm.description}
                  onChange={(e) => setNewForm((f) => ({ ...f, description: e.target.value }))}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
                  placeholder="Additional details about this request..."
                />
              </div>
              <p className="text-xs text-gray-400">A 30-day due date will be automatically set from today.</p>
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={newLoading}
                  className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 transition-opacity"
                  style={{ backgroundColor: "#4338CA" }}
                >
                  {newLoading ? "Saving..." : "Create DSAR"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Status Update Modal */}
      {selectedDsar && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900">Update DSAR Status</h2>
              <button
                onClick={() => { setSelectedDsar(null); setUpdateStatus(""); setResponse(""); setError(null) }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleStatusUpdate} className="p-6 space-y-4">
              <div className="text-sm text-gray-600">
                <span className="font-semibold">{selectedDsar.reference}</span> —{" "}
                {selectedDsar.client.firstName} {selectedDsar.client.lastName}
                <span className="ml-2 text-xs text-gray-400">({TYPE_LABELS[selectedDsar.type]})</span>
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">New Status *</label>
                <div className="flex gap-2 flex-wrap">
                  {NEXT_STATUS[selectedDsar.status].map((s) => {
                    const sc = STATUS_COLORS[s] ?? { bg: "#F3F4F6", text: "#374151" }
                    return (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setUpdateStatus(s)}
                        className="px-3 py-1.5 rounded-lg text-[11px] font-semibold border-2 transition-all"
                        style={{
                          backgroundColor: updateStatus === s ? sc.bg : "transparent",
                          color: updateStatus === s ? sc.text : "#6B7280",
                          borderColor: updateStatus === s ? sc.text : "#E5E7EB",
                        }}
                      >
                        {STATUS_LABELS[s] ?? s}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Response / Notes</label>
                <textarea
                  value={response}
                  onChange={(e) => setResponse(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
                  placeholder="Describe the action taken or response provided..."
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={updating || !updateStatus}
                  className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 transition-opacity"
                  style={{ backgroundColor: "#4338CA" }}
                >
                  {updating ? "Updating..." : "Update DSAR"}
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedDsar(null); setUpdateStatus(""); setResponse(""); setError(null) }}
                  className="px-4 py-2 rounded-md border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
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
