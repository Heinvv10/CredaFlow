"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { formatDate } from "@/lib/utils"
import { Plus, X } from "lucide-react"
import {
  COMPLAINT_ACTION_LABELS,
  complaintActionBody,
  complaintStatusLabel,
  complaintTiles,
  nextComplaintActions,
  type ComplaintAction,
} from "@/lib/complaints/status-flow"

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
  phone: string
  email: string | null
}

type Complaint = {
  id: string
  reference: string
  clientId: string
  category: string
  description: string
  status: string
  assignedToId: string | null
  acknowledgedAt: Date | string | null
  resolution: string | null
  outcome: string | null
  resolvedAt: Date | string | null
  createdAt: Date | string
  client: Client
}

const STATUS_TABS = ["ALL", "OPEN", "UNDER_INVESTIGATION", "RESOLVED", "ESCALATED", "ESCALATED_OMBUD", "CLOSED"] as const
type StatusTab = typeof STATUS_TABS[number]

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  UNDER_INVESTIGATION: "Under Investigation",
  RESOLVED: "Resolved",
  ESCALATED: "Escalated",
  ESCALATED_OMBUD: "Escalated to Ombud",
  CLOSED: "Closed",
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  OPEN: { bg: "#FEF3C7", text: "#92400E" },
  UNDER_INVESTIGATION: { bg: "#DBEAFE", text: "#1E40AF" },
  RESOLVED: { bg: "#D1FAE5", text: "#065F46" },
  ESCALATED: { bg: "#FEE2E2", text: "#991B1B" },
  ESCALATED_OMBUD: { bg: "#FDF2F8", text: "#86198F" },
  CLOSED: { bg: "#F3F4F6", text: "#374151" },
}

const TILE_COLORS: Record<string, { color: string; bg: string }> = {
  total: { color: "#1565c0", bg: "#DBEAFE" },
  open: { color: "#92400E", bg: "#FEF3C7" },
  underInvestigation: { color: "#1E40AF", bg: "#DBEAFE" },
  resolved: { color: "#065F46", bg: "#D1FAE5" },
  escalated: { color: "#991B1B", bg: "#FEE2E2" },
}

const CATEGORY_LABELS: Record<string, string> = {
  FEES_AND_CHARGES: "Fees & Charges",
  COLLECTIONS_CONDUCT: "Collections Conduct",
  CREDIT_AGREEMENT: "Credit Agreement",
  INSURANCE: "Insurance",
  DATA_PRIVACY: "Data Privacy",
  SERVICE_QUALITY: "Service Quality",
  OTHER: "Other",
}

const CATEGORIES = Object.keys(CATEGORY_LABELS)

function isUnacknowledgedOver24h(complaint: Complaint): boolean {
  if (complaint.acknowledgedAt) return false
  const ageMs = Date.now() - new Date(complaint.createdAt).getTime()
  return ageMs > 24 * 60 * 60 * 1000
}

function daysOpen(createdAt: Date | string) {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000)
}

export function ComplaintsClient({
  complaints,
  clients,
}: {
  complaints: Complaint[]
  clients: ClientOption[]
}) {
  const router = useRouter()
  const [statusTab, setStatusTab] = useState<StatusTab>("ALL")
  const [showNewModal, setShowNewModal] = useState(false)
  const [selectedComplaint, setSelectedComplaint] = useState<Complaint | null>(null)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // New complaint form state
  const [newForm, setNewForm] = useState({
    clientId: "",
    category: "SERVICE_QUALITY",
    description: "",
  })
  const [newLoading, setNewLoading] = useState(false)
  const [newError, setNewError] = useState<string | null>(null)

  // Status update modal state
  const [updateStatus, setUpdateStatus] = useState<ComplaintAction | "">("")
  const [resolution, setResolution] = useState("")

  const filtered = complaints.filter((c) => {
    if (statusTab !== "ALL" && c.status !== statusTab) return false
    return true
  })

  const tiles = complaintTiles(complaints)

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newForm.clientId || !newForm.description) {
      setNewError("Client and description are required.")
      return
    }
    setNewLoading(true)
    setNewError(null)
    try {
      const res = await fetch("/api/complaints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newForm),
      })
      if (!res.ok) throw new Error("Failed to create complaint")
      setShowNewModal(false)
      setNewForm({ clientId: "", category: "SERVICE_QUALITY", description: "" })
      router.refresh()
    } catch (err) {
      setNewError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setNewLoading(false)
    }
  }

  const handleStatusUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedComplaint || !updateStatus) return
    setUpdating(true)
    setError(null)
    try {
      const body: Record<string, unknown> = { ...complaintActionBody(updateStatus) }
      if (resolution) body.resolution = resolution
      const res = await fetch(`/api/complaints/${selectedComplaint.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error("Failed to update complaint")
      setSelectedComplaint(null)
      setUpdateStatus("")
      setResolution("")
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
          <h1 className="text-2xl font-bold text-[#1b1d24]">Complaints Management</h1>
          <p className="text-sm text-gray-500 mt-1">NCR · FSCA complaint tracking and resolution</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/compliance"
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            ← Compliance
          </Link>
          <button
            onClick={() => setShowNewModal(true)}
            className="flex items-center gap-2 px-4 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA] transition-colors"
          >
            <Plus className="h-4 w-4" /> New Complaint
          </button>
        </div>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {tiles.map((tile) => ({ ...tile, ...TILE_COLORS[tile.key] })).map((s) => (
          <div key={s.label} className="bg-white rounded-xl shadow-sm p-4" style={{ borderLeft: `4px solid ${s.color}` }}>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">{s.label}</p>
            <p className="text-2xl font-extrabold" style={{ color: s.color }}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-4 bg-gray-100 p-1 rounded-lg w-fit overflow-x-auto">
        {STATUS_TABS.map((tab) => {
          const count = tab === "ALL"
            ? complaints.length
            : complaints.filter((c) => c.status === tab).length
          return (
            <button
              key={tab}
              onClick={() => setStatusTab(tab)}
              className={`px-3 py-1.5 rounded-md text-[11px] font-semibold whitespace-nowrap transition-colors ${
                statusTab === tab
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {tab === "ALL" ? "All" : STATUS_LABELS[tab]}{" "}
              <span className="text-[10px] text-gray-400">{count}</span>
            </button>
          )
        })}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ backgroundColor: "#F8F8F8", borderBottom: "1px solid #E5E7EB" }}>
              {["Complaint Ref", "Client", "Date Lodged", "Category", "Status", "SLA", "Actions"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((c, i) => {
              const sc = STATUS_COLORS[c.status] ?? { bg: "#F3F4F6", text: "#374151" }
              const days = daysOpen(c.createdAt)
              return (
                <tr
                  key={c.id}
                  className="border-b border-gray-50 hover:bg-gray-50 transition-colors"
                  style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}
                >
                  <td className="px-4 py-3.5">
                    <span className="font-mono text-xs text-gray-500">{c.reference}</span>
                  </td>
                  <td className="px-4 py-3.5">
                    <p className="font-semibold text-gray-900 text-[13px]">
                      {c.client.firstName} {c.client.lastName}
                    </p>
                    <p className="text-[11px] text-gray-400">{c.client.phone}</p>
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-600">
                    {formatDate(c.createdAt)}
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-600">
                    {CATEGORY_LABELS[c.category] ?? c.category}
                  </td>
                  <td className="px-4 py-3.5">
                    <span
                      className="inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-semibold"
                      style={{ backgroundColor: sc.bg, color: sc.text }}
                    >
                      {complaintStatusLabel(c)}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-600">
                    {c.status === "RESOLVED" || c.status === "CLOSED" ? (
                      <span className="text-gray-400">—</span>
                    ) : (
                      <div className="flex flex-col gap-1">
                        <span className={days > 14 ? "text-red-600 font-semibold" : ""}>{days}d open</span>
                        {isUnacknowledgedOver24h(c) && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-100 text-amber-800 whitespace-nowrap">
                            &gt;24h unacknowledged
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    {nextComplaintActions(c).length > 0 && (
                      <button
                        onClick={() => {
                          setSelectedComplaint(c)
                          setUpdateStatus(nextComplaintActions(c)[0])
                          setResolution(c.resolution ?? "")
                          setError(null)
                        }}
                        className="text-[11px] font-medium px-2.5 py-1 rounded border border-gray-200 hover:border-[#4338CA] hover:text-[#4F46E5] transition-colors"
                      >
                        Update Status
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400 text-sm">
                  No complaints found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* New Complaint Modal */}
      {showNewModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900">New Complaint</h2>
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
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Category *</label>
                <select
                  value={newForm.category}
                  onChange={(e) => setNewForm((f) => ({ ...f, category: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] bg-white"
                >
                  {CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>
                      {CATEGORY_LABELS[cat]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Description *</label>
                <textarea
                  value={newForm.description}
                  onChange={(e) => setNewForm((f) => ({ ...f, description: e.target.value }))}
                  rows={4}
                  required
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
                  placeholder="Describe the complaint in detail..."
                />
              </div>
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={newLoading}
                  className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 transition-opacity"
                  style={{ backgroundColor: "#4338CA" }}
                >
                  {newLoading ? "Saving..." : "Lodge Complaint"}
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
      {selectedComplaint && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900">Update Complaint Status</h2>
              <button
                onClick={() => { setSelectedComplaint(null); setUpdateStatus(""); setResolution(""); setError(null) }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleStatusUpdate} className="p-6 space-y-4">
              <div className="text-sm text-gray-600">
                <span className="font-semibold">{selectedComplaint.reference}</span> —{" "}
                {selectedComplaint.client.firstName} {selectedComplaint.client.lastName}
              </div>

              {error && (
                <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">New Status *</label>
                <div className="flex gap-2 flex-wrap">
                  {nextComplaintActions(selectedComplaint).map((s) => {
                    const sc = STATUS_COLORS[s === "ACKNOWLEDGE" ? "OPEN" : s] ?? { bg: "#F3F4F6", text: "#374151" }
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
                        {COMPLAINT_ACTION_LABELS[s]}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Resolution Notes</label>
                <textarea
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
                  placeholder="Add resolution or investigation notes..."
                />
              </div>

              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={updating || !updateStatus}
                  className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 transition-opacity"
                  style={{ backgroundColor: "#4338CA" }}
                >
                  {updating ? "Updating..." : "Update Status"}
                </button>
                <button
                  type="button"
                  onClick={() => { setSelectedComplaint(null); setUpdateStatus(""); setResolution(""); setError(null) }}
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
