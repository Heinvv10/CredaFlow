"use client"

import { useState, useEffect } from "react"
import { formatZAR } from "@/lib/utils"

interface ArrangementData {
  agreedAmount: number
  frequency: string
  startDate: string
  endDate: string
  notes?: string
}

interface ArrangementAnalysis {
  overallStatus: "ON_TRACK" | "PARTIAL" | "BROKEN" | "COMPLETED"
  complianceRate: number
  keptCount: number
  missedCount: number
  partialCount: number
  upcomingCount: number
}

interface Props {
  loanId: string
  existingArrangement: ArrangementData
}

export function ArrangementSummary({ loanId, existingArrangement }: Props) {
  const [analysis, setAnalysis] = useState<ArrangementAnalysis | null>(null)
  const [displayStatus, setDisplayStatus] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState(false)

  useEffect(() => {
    fetch(`/api/loans/${loanId}/arrangement-status`, { credentials: "include" })
      .then(r => r.json())
      .then((d: { arrangement: { status: string } | null; analysis: ArrangementAnalysis | null }) => {
        if (d.analysis) setAnalysis(d.analysis)
        if (d.arrangement) setDisplayStatus(d.arrangement.status)
      })
      .catch(() => setFetchError(true))
  }, [loanId])

  const bgClass = displayStatus === "BROKEN"
    ? "bg-red-50"
    : displayStatus === "KEPT" || displayStatus === "COMPLETED"
    ? "bg-emerald-50"
    : "bg-green-50"

  return (
    <div className={`px-5 py-3 border-t border-gray-50 ${bgClass}`}>
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11px] font-semibold text-gray-600 uppercase tracking-wide">Payment Arrangement</p>
        {displayStatus && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wide ${
            displayStatus === "KEPT" ? "bg-emerald-100 text-emerald-800"
            : displayStatus === "BROKEN" ? "bg-red-100 text-red-800"
            : displayStatus === "PARTIAL" ? "bg-amber-100 text-amber-800"
            : displayStatus === "COMPLETED" ? "bg-blue-100 text-blue-800"
            : "bg-green-100 text-green-800"
          }`}>
            {displayStatus === "KEPT" ? "Keeping" : displayStatus}
          </span>
        )}
      </div>
      <p className="text-sm text-gray-800">
        {formatZAR(existingArrangement.agreedAmount)} / {existingArrangement.frequency.toLowerCase()} ·{" "}
        {/* Explicit timeZone: without it this resolves to the JS runtime's
            local zone, which differs between the server (SSR, typically
            UTC) and the browser (SAST) — a text mismatch that trips React
            hydration (#418). */}
        {new Date(existingArrangement.startDate).toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg" })} →{" "}
        {new Date(existingArrangement.endDate).toLocaleDateString("en-ZA", { timeZone: "Africa/Johannesburg" })}
      </p>
      {analysis && !fetchError && (
        <div className="flex items-center gap-3 mt-1.5">
          <span className="text-[11px] text-gray-500">
            Compliance: <span className={`font-semibold ${analysis.complianceRate >= 80 ? "text-emerald-700" : analysis.complianceRate >= 50 ? "text-amber-700" : "text-red-700"}`}>{analysis.complianceRate}%</span>
          </span>
          {analysis.keptCount > 0 && <span className="text-[11px] text-emerald-600">{analysis.keptCount} kept</span>}
          {analysis.missedCount > 0 && <span className="text-[11px] text-red-600">{analysis.missedCount} missed</span>}
          {analysis.partialCount > 0 && <span className="text-[11px] text-amber-600">{analysis.partialCount} partial</span>}
          {analysis.upcomingCount > 0 && <span className="text-[11px] text-gray-400">{analysis.upcomingCount} upcoming</span>}
        </div>
      )}
      {existingArrangement.notes && <p className="text-xs text-gray-500 mt-0.5">{existingArrangement.notes}</p>}
    </div>
  )
}
