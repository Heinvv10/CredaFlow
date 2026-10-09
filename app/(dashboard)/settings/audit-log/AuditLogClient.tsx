"use client"

import { Fragment, useState } from "react"
import { Search, Filter, Download } from "lucide-react"
import { SAST_TIME_ZONE } from "@/lib/utils"
import type { AuditTimelineEntry } from "@/lib/audit/document-access-timeline"

interface User {
  id: string
  name: string | null
  email: string
}

interface Props {
  initialLogs: AuditTimelineEntry[]
  users: User[]
}

const ACTION_COLORS: Record<string, { bg: string; text: string }> = {
  LOAN_APPROVED: { bg: "#D1FAE5", text: "#065F46" },
  LOAN_DECLINED: { bg: "#FEE2E2", text: "#991B1B" },
  LOAN_DISBURSED: { bg: "#DBEAFE", text: "#1E40AF" },
  AGREEMENT_SIGNED: { bg: "#EDE9FE", text: "#5B21B6" },
  AGREEMENT_PROVIDER_COUNTERSIGNED: { bg: "#DBEAFE", text: "#1E40AF" },
  PAYMENT_RECORDED: { bg: "#D1FAE5", text: "#065F46" },
  CLIENT_CREATED: { bg: "#FEF3C7", text: "#92400E" },
  CLIENT_UPDATED: { bg: "#FEF9C3", text: "#713F12" },
  KYC_APPROVED: { bg: "#D1FAE5", text: "#065F46" },
  KYC_REJECTED: { bg: "#FEE2E2", text: "#991B1B" },
  DOCUMENT_UPLOADED: { bg: "#F0F9FF", text: "#0C4A6E" },
}

function getActionStyle(action: string) {
  return ACTION_COLORS[action] ?? { bg: "#F3F4F6", text: "#6B7280" }
}

export function AuditLogClient({ initialLogs, users }: Props) {
  const [logs] = useState(initialLogs)
  const [search, setSearch] = useState("")
  const [entityFilter, setEntityFilter] = useState("all")
  const [userFilter, setUserFilter] = useState("all")
  const [fromDate, setFromDate] = useState("")
  const [toDate, setToDate] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)

  const entities = [...new Set(logs.map((l) => l.entity))].sort()

  const filtered = logs.filter((l) => {
    if (entityFilter !== "all" && l.entity !== entityFilter) return false
    if (userFilter !== "all" && l.userId !== userFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        l.action.toLowerCase().includes(q) ||
        l.entity.toLowerCase().includes(q) ||
        l.entityId?.toLowerCase().includes(q) ||
        l.userEmail?.toLowerCase().includes(q) ||
        l.userName?.toLowerCase().includes(q) ||
        l.actorLabel.toLowerCase().includes(q) ||
        l.ipAddress?.includes(q)
      )
    }
    return true
  })

  return (
    <div>
      {/* Filters */}
      <div className="bg-white border-b border-[#e2e5ea] px-6 py-3 flex items-center gap-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" />
          <input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-[#4F46E5]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-gray-400" />
          <select
            value={entityFilter}
            onChange={(e) => setEntityFilter(e.target.value)}
            className="border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-600 focus:outline-none"
          >
            <option value="all">All Entities</option>
            {entities.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <select
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            className="border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-600 focus:outline-none"
          >
            <option value="all">All Users</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email}</option>)}
          </select>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            aria-label="From date (export only)"
            title="From date — applies to Excel export only"
            className="border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-600 focus:outline-none"
          />
          <span className="text-xs text-gray-400">→</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            aria-label="To date (export only)"
            title="To date — applies to Excel export only"
            className="border border-gray-200 rounded px-2 py-1.5 text-sm text-gray-600 focus:outline-none"
          />
        </div>
        <p className="text-xs text-gray-400 ml-auto">{filtered.length} entries</p>
        <a
          href={(() => {
            const params = new URLSearchParams({ type: "audit-log" })
            if (entityFilter !== "all") params.set("entity", entityFilter)
            if (userFilter !== "all") params.set("userId", userFilter)
            if (search.trim()) params.set("search", search.trim())
            if (fromDate) params.set("from", fromDate)
            if (toDate) params.set("to", toDate)
            return `/api/reports/export?${params.toString()}`
          })()}
          title={
            fromDate || toDate
              ? "Exports all matching audit rows in the chosen date range"
              : "Exports all matching audit rows from the last 90 days (set a date range to override)"
          }
          className="flex items-center gap-1.5 px-3 py-1.5 bg-[#1e6b3f] text-white rounded text-xs font-semibold hover:bg-[#155030] transition-colors"
        >
          <Download className="h-3.5 w-3.5" />
          Export Excel
        </a>
      </div>

      <div className="p-6">
        <div className="bg-white rounded-lg border border-[#e5e7eb] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[#f9fafb] border-b border-[#e5e7eb]">
              <tr>
                {["When", "Who", "Action", "Entity", "Entity ID", "IP"].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-gray-500">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#eceef2]">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-gray-400 text-sm">No audit entries found</td>
                </tr>
              ) : (
                filtered.map((log) => {
                  const style = getActionStyle(log.action)
                  const isExpanded = expanded === log.id
                  const hasDetails = log.oldValue || log.newValue

                  return (
                    <Fragment key={log.id}>
                      <tr
                        className={`hover:bg-[#f9fafb] ${hasDetails ? "cursor-pointer" : ""}`}
                        onClick={() => hasDetails && setExpanded(isExpanded ? null : log.id)}
                      >
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                          {new Date(log.createdAt).toLocaleString("en-ZA", { timeZone: SAST_TIME_ZONE })}
                        </td>
                        <td className="px-4 py-3">
                          <p className="text-[12px] font-medium text-[#262a33]">{log.userName ?? "—"}</p>
                          <p className="text-[11px] text-gray-400">{log.actorLabel}</p>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
                            style={{ backgroundColor: style.bg, color: style.text }}
                          >
                            {log.action.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[12px] text-gray-600">{log.entity}</td>
                        <td className="px-4 py-3 font-mono text-[11px] text-gray-500 max-w-[120px] truncate">{log.entityId ?? "—"}</td>
                        <td className="px-4 py-3 text-[11px] text-gray-400">{log.ipAddress ?? "—"}</td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={6} className="px-4 py-3 bg-gray-50 border-t border-[#eceef2]">
                            <div className="grid grid-cols-2 gap-4 text-xs">
                              {log.oldValue && (
                                <div>
                                  <p className="font-medium text-gray-500 mb-1">Old Value</p>
                                  <pre className="bg-white border rounded p-2 overflow-auto max-h-32 text-gray-600">{JSON.stringify(log.oldValue, null, 2)}</pre>
                                </div>
                              )}
                              {log.newValue && (
                                <div>
                                  <p className="font-medium text-gray-500 mb-1">New Value</p>
                                  <pre className="bg-white border rounded p-2 overflow-auto max-h-32 text-gray-600">{JSON.stringify(log.newValue, null, 2)}</pre>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
