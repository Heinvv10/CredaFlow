"use client"

import { useEffect, useState } from "react"
import { CheckCircle, XCircle, AlertCircle, Clock, TrendingUp } from "lucide-react"
import { SAST_TIME_ZONE, formatZAR } from "@/lib/utils"

interface Installment {
  period: number
  dueDate: string
  expectedAmount: number
  actualAmount: number
  status: "PAID" | "PARTIAL" | "MISSED" | "UPCOMING"
  variance: number
}

interface Analysis {
  installments: Installment[]
  totalExpected: number
  totalPaid: number
  totalMissed: number
  keptCount: number
  missedCount: number
  partialCount: number
  upcomingCount: number
  overallStatus: "ON_TRACK" | "PARTIAL" | "BROKEN" | "COMPLETED"
  complianceRate: number
}

interface Arrangement {
  agreedAmount: number
  frequency: string
  startDate: string
  endDate: string
  status: string
  notes?: string
}

interface Props {
  loanId: string
}

const STATUS_CONFIG = {
  ON_TRACK:  { label: "On Track",  color: "#10B981", bg: "#D1FAE5", icon: TrendingUp },
  PARTIAL:   { label: "Partial",   color: "#F59E0B", bg: "#FEF3C7", icon: AlertCircle },
  BROKEN:    { label: "Broken",    color: "#EF4444", bg: "#FEE2E2", icon: XCircle },
  COMPLETED: { label: "Completed", color: "#6366F1", bg: "#EDE9FE", icon: CheckCircle },
}

const INSTALLMENT_STATUS = {
  PAID:     { color: "#10B981", bg: "#D1FAE5", icon: CheckCircle,  label: "Paid" },
  PARTIAL:  { color: "#F59E0B", bg: "#FEF3C7", icon: AlertCircle,  label: "Partial" },
  MISSED:   { color: "#EF4444", bg: "#FEE2E2", icon: XCircle,      label: "Missed" },
  UPCOMING: { color: "#9CA3AF", bg: "#F3F4F6", icon: Clock,        label: "Upcoming" },
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-ZA", { day: "2-digit", month: "short", year: "numeric", timeZone: SAST_TIME_ZONE })
}

export function ArrangementTracker({ loanId }: Props) {
  const [data, setData] = useState<{ arrangement: Arrangement; analysis: Analysis } | null>(null)
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    fetch(`/api/loans/${loanId}/arrangement-status`)
      .then(r => r.json())
      .then(d => {
        if (d.arrangement) setData(d as { arrangement: Arrangement; analysis: Analysis })
      })
      .finally(() => setLoading(false))
  }, [loanId])

  if (loading) {
    return (
      <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-5">
        <div className="h-4 bg-gray-100 rounded animate-pulse w-1/3 mb-3" />
        <div className="h-20 bg-gray-50 rounded animate-pulse" />
      </div>
    )
  }

  if (!data) return null

  const { arrangement, analysis } = data
  const cfg = STATUS_CONFIG[analysis.overallStatus]
  const StatusIcon = cfg.icon

  const displayInstallments = showAll
    ? analysis.installments
    : analysis.installments.slice(-6)

  return (
    <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: cfg.bg }}>
            <StatusIcon className="h-4 w-4" style={{ color: cfg.color }} />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Arrangement Tracking</p>
            <p className="font-semibold text-sm mt-0.5" style={{ color: cfg.color }}>{cfg.label}</p>
          </div>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold" style={{ color: cfg.color }}>{analysis.complianceRate}%</p>
          <p className="text-[11px] text-gray-400">compliance</p>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-4 divide-x divide-gray-50 border-b border-gray-50">
        {[
          { label: "Kept", value: analysis.keptCount, color: "#10B981" },
          { label: "Partial", value: analysis.partialCount, color: "#F59E0B" },
          { label: "Missed", value: analysis.missedCount, color: "#EF4444" },
          { label: "Upcoming", value: analysis.upcomingCount, color: "#9CA3AF" },
        ].map(s => (
          <div key={s.label} className="px-4 py-3 text-center">
            <p className="text-lg font-bold" style={{ color: s.color }}>{s.value}</p>
            <p className="text-[11px] text-gray-400">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Amounts */}
      <div className="px-5 py-3 flex items-center justify-between border-b border-gray-50 text-sm">
        <div>
          <span className="text-gray-400 text-[11px]">EXPECTED</span>
          <p className="whitespace-nowrap font-semibold text-gray-700">{formatZAR(analysis.totalExpected)}</p>
        </div>
        <div className="text-right">
          <span className="text-gray-400 text-[11px]">PAID</span>
          <p className="whitespace-nowrap font-semibold text-green-600">{formatZAR(analysis.totalPaid)}</p>
        </div>
        {analysis.totalMissed > 0 && (
          <div className="text-right">
            <span className="text-gray-400 text-[11px]">MISSED</span>
            <p className="whitespace-nowrap font-semibold text-red-500">{formatZAR(analysis.totalMissed)}</p>
          </div>
        )}
        <div className="text-right">
          <span className="text-gray-400 text-[11px]">FREQ</span>
          <p className="font-semibold text-gray-700 capitalize">{arrangement.frequency.toLowerCase()}</p>
        </div>
      </div>

      {/* Installment timeline */}
      <div className="px-5 py-3">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Installments</p>
          {analysis.installments.length > 6 && (
            <button onClick={() => setShowAll(!showAll)} className="text-[11px] font-medium hover:underline" style={{ color: "#4338CA" }}>
              {showAll ? "Show less" : `Show all ${analysis.installments.length}`}
            </button>
          )}
        </div>
        <div className="space-y-1.5">
          {displayInstallments.map(inst => {
            const sc = INSTALLMENT_STATUS[inst.status]
            const InstIcon = sc.icon
            return (
              <div key={inst.period} className="flex items-center gap-3 px-3 py-2 rounded-md" style={{ backgroundColor: sc.bg }}>
                <InstIcon className="h-4 w-4 flex-shrink-0" style={{ color: sc.color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="text-[12px] font-medium text-gray-700">#{inst.period} · {formatDate(inst.dueDate)}</span>
                    <span className="text-[11px] font-semibold" style={{ color: sc.color }}>{sc.label}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-gray-500">Expected: <span className="whitespace-nowrap">{formatZAR(inst.expectedAmount)}</span></span>
                    {inst.status !== "UPCOMING" && (
                      <>
                        <span className="text-gray-300">·</span>
                        <span className="text-[11px]" style={{ color: sc.color }}>Paid: <span className="whitespace-nowrap">{formatZAR(inst.actualAmount)}</span></span>
                        {inst.variance < 0 && (
                          <>
                            <span className="text-gray-300">·</span>
                            <span className="text-[11px] text-red-500">Short: <span className="whitespace-nowrap">{formatZAR(Math.abs(inst.variance))}</span></span>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Arrangement meta */}
      <div className="px-5 py-3 border-t border-gray-50 text-[11px] text-gray-400">
        {formatDate(arrangement.startDate)} → {formatDate(arrangement.endDate)}
        {arrangement.notes && <span> · {arrangement.notes}</span>}
      </div>
    </div>
  )
}
