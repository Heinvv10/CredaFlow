"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { formatDate } from "@/lib/utils"
import { Plus, X, ChevronDown } from "lucide-react"

type BreachLog = {
  id: string
  incidentDate: string | Date
  discoveredDate: string | Date
  description: string
  affectedClients: number
  dataCategories: string
  containmentAction: string | null
  reportedToIC: boolean
  reportedAt: string | Date | null
  status: string
  createdBy: string | null
  createdAt: string | Date
}

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  OPEN: { bg: "#FEE2E2", text: "#991B1B" },
  CONTAINED: { bg: "#FEF3C7", text: "#92400E" },
  RESOLVED: { bg: "#D1FAE5", text: "#065F46" },
}

const STATUS_TRANSITIONS: Record<string, string[]> = {
  OPEN: ["CONTAINED", "RESOLVED"],
  CONTAINED: ["RESOLVED"],
  RESOLVED: [],
}

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  CONTAINED: "Contained",
  RESOLVED: "Resolved",
}

const today = () => new Date().toISOString().slice(0, 10)

export function BreachLogClient({ logs }: { logs: BreachLog[] }) {
  const router = useRouter()
  const [showNewModal, setShowNewModal] = useState(false)
  const [selectedLog, setSelectedLog] = useState<BreachLog | null>(null)
  const [updateStatus, setUpdateStatus] = useState("")
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState<string | null>(null)

  const [newForm, setNewForm] = useState({
    incidentDate: today(),
    discoveredDate: today(),
    description: "",
    affectedClients: "",
    dataCategories: "",
    containmentAction: "",
    reportedToIC: false,
    reportedAt: "",
  })
  const [newLoading, setNewLoading] = useState(false)
  const [newError, setNewError] = useState<string | null>(null)

  const stats = {
    total: logs.length,
    open: logs.filter((l) => l.status === "OPEN").length,
    contained: logs.filter((l) => l.status === "CONTAINED").length,
    resolved: logs.filter((l) => l.status === "RESOLVED").length,
  }

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newForm.incidentDate || !newForm.discoveredDate || !newForm.description || !newForm.dataCategories) {
      setNewError("Incident date, discovered date, description and data categories are required.")
      return
    }
    setNewLoading(true)
    setNewError(null)
    try {
      const res = await fetch("/api/compliance/breach-log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          incidentDate: newForm.incidentDate,
          discoveredDate: newForm.discoveredDate,
          description: newForm.description,
          affectedClients: newForm.affectedClients ? parseInt(newForm.affectedClients, 10) : 0,
          dataCategories: newForm.dataCategories,
          containmentAction: newForm.containmentAction || undefined,
          reportedToIC: newForm.reportedToIC,
          reportedAt: newForm.reportedAt || undefined,
        }),
      })
      if (!res.ok) throw new Error("Failed to log breach incident")
      setShowNewModal(false)
      setNewForm({
        incidentDate: today(),
        discoveredDate: today(),
        description: "",
        affectedClients: "",
        dataCategories: "",
        containmentAction: "",
        reportedToIC: false,
        reportedAt: "",
      })
      router.refresh()
    } catch (err) {
      setNewError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setNewLoading(false)
    }
  }

  const handleStatusUpdate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedLog || !updateStatus) return
    setUpdating(true)
    setUpdateError(null)
    try {
      const res = await fetch(`/api/compliance/breach-log/${selectedLog.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: updateStatus }),
      })
      if (!res.ok) throw new Error("Failed to update status")
      setSelectedLog(null)
      setUpdateStatus("")
      router.refresh()
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1b1d24]">Breach Log</h1>
          <p className="text-sm text-gray-500 mt-1">POPIA · FSCA data breach incident management</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/compliance" className="text-sm text-gray-500 hover:text-gray-700">
            ← Compliance
          </Link>
          <button
            onClick={() => { setShowNewModal(true); setNewError(null) }}
            className="flex items-center gap-2 px-4 py-2 bg-[#4F46E5] text-white rounded-lg text-sm font-medium hover:bg-[#4338CA] transition-colors"
          >
            <Plus className="h-4 w-4" /> Log Breach Incident
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {[
          { label: "Total", value: stats.total, color: "#1565c0" },
          { label: "Open", value: stats.open, color: "#991B1B" },
          { label: "Contained", value: stats.contained, color: "#92400E" },
          { label: "Resolved", value: stats.resolved, color: "#065F46" },
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
              {["Incident Date", "Description", "Affected Clients", "Data Categories", "Status", "Reported to IC", "Actions"].map((h) => (
                <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {logs.map((log, i) => {
              const sc = STATUS_COLORS[log.status] ?? { bg: "#F3F4F6", text: "#374151" }
              return (
                <tr
                  key={log.id}
                  className="border-b border-gray-50 hover:bg-gray-50 transition-colors"
                  style={{ backgroundColor: i % 2 === 0 ? "#FFF" : "#FAFAFA" }}
                >
                  <td className="px-4 py-3.5 text-[13px] text-gray-700 whitespace-nowrap">
                    {formatDate(log.incidentDate)}
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-700 max-w-xs">
                    <p className="line-clamp-2">{log.description}</p>
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-700 text-center">
                    {log.affectedClients}
                  </td>
                  <td className="px-4 py-3.5 text-[13px] text-gray-600 max-w-[160px]">
                    <p className="line-clamp-2">{log.dataCategories}</p>
                  </td>
                  <td className="px-4 py-3.5">
                    <span
                      className="inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-semibold"
                      style={{ backgroundColor: sc.bg, color: sc.text }}
                    >
                      {STATUS_LABELS[log.status] ?? log.status}
                    </span>
                  </td>
                  <td className="px-4 py-3.5 text-[13px]">
                    {log.reportedToIC ? (
                      <span className="text-green-700 font-medium">
                        Yes{log.reportedAt ? ` · ${formatDate(log.reportedAt)}` : ""}
                      </span>
                    ) : (
                      <span className="text-gray-400">No</span>
                    )}
                  </td>
                  <td className="px-4 py-3.5">
                    {STATUS_TRANSITIONS[log.status]?.length > 0 && (
                      <div className="relative group">
                        <button
                          onClick={() => {
                            setSelectedLog(log)
                            setUpdateStatus(STATUS_TRANSITIONS[log.status][0])
                            setUpdateError(null)
                          }}
                          className="flex items-center gap-1 text-[11px] font-medium px-2.5 py-1 rounded border border-gray-200 hover:border-[#4338CA] hover:text-[#4F46E5] transition-colors"
                        >
                          Update <ChevronDown className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
            {logs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400 text-sm">
                  No breach incidents logged
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* New Breach Modal */}
      {showNewModal && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900">Log Breach Incident</h2>
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
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Incident Date *</label>
                  <input
                    type="date"
                    value={newForm.incidentDate}
                    onChange={(e) => setNewForm((f) => ({ ...f, incidentDate: e.target.value }))}
                    required
                    className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Discovered Date *</label>
                  <input
                    type="date"
                    value={newForm.discoveredDate}
                    onChange={(e) => setNewForm((f) => ({ ...f, discoveredDate: e.target.value }))}
                    required
                    className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Description *</label>
                <textarea
                  value={newForm.description}
                  onChange={(e) => setNewForm((f) => ({ ...f, description: e.target.value }))}
                  rows={3}
                  required
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
                  placeholder="Describe the nature of the breach..."
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Affected Clients</label>
                  <input
                    type="number"
                    min="0"
                    value={newForm.affectedClients}
                    onChange={(e) => setNewForm((f) => ({ ...f, affectedClients: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Data Categories *</label>
                  <input
                    type="text"
                    value={newForm.dataCategories}
                    onChange={(e) => setNewForm((f) => ({ ...f, dataCategories: e.target.value }))}
                    required
                    className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
                    placeholder="e.g. ID numbers, financial data"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">Containment Action</label>
                <textarea
                  value={newForm.containmentAction}
                  onChange={(e) => setNewForm((f) => ({ ...f, containmentAction: e.target.value }))}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA] resize-none"
                  placeholder="Steps taken to contain the breach..."
                />
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newForm.reportedToIC}
                    onChange={(e) => setNewForm((f) => ({ ...f, reportedToIC: e.target.checked }))}
                    className="rounded border-gray-300"
                  />
                  Reported to Information Commissioner
                </label>
              </div>
              {newForm.reportedToIC && (
                <div>
                  <label className="block text-xs font-semibold text-gray-600 mb-1.5">Reported At</label>
                  <input
                    type="date"
                    value={newForm.reportedAt}
                    onChange={(e) => setNewForm((f) => ({ ...f, reportedAt: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none focus:border-[#4338CA]"
                  />
                </div>
              )}
              <div className="flex items-center gap-3 pt-2">
                <button
                  type="submit"
                  disabled={newLoading}
                  className="px-5 py-2 rounded-md text-white text-sm font-medium disabled:opacity-60 transition-opacity"
                  style={{ backgroundColor: "#4338CA" }}
                >
                  {newLoading ? "Saving..." : "Log Incident"}
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
      {selectedLog && (
        <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h2 className="font-bold text-gray-900">Update Breach Status</h2>
              <button
                onClick={() => { setSelectedLog(null); setUpdateStatus(""); setUpdateError(null) }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <form onSubmit={handleStatusUpdate} className="p-6 space-y-4">
              <p className="text-sm text-gray-600 line-clamp-2">{selectedLog.description}</p>

              {updateError && (
                <div className="bg-red-50 border border-red-200 rounded-md px-4 py-3 text-sm text-red-700">
                  {updateError}
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1.5">New Status *</label>
                <div className="flex gap-2 flex-wrap">
                  {STATUS_TRANSITIONS[selectedLog.status].map((s) => {
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
                        Mark {STATUS_LABELS[s]}
                      </button>
                    )
                  })}
                </div>
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
                  onClick={() => { setSelectedLog(null); setUpdateStatus(""); setUpdateError(null) }}
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
