"use client"

import { AlertTriangle, UserCheck, Calendar, FileText } from "lucide-react"

interface Props {
  writeOffAt: string
  writeOffReason: string
  approvedByName?: string | null
  outstandingAtWriteOff?: number
}

function formatDate(d: string) {
  // Explicit timeZone: without it this resolves to the JS runtime's local
  // zone, which differs between the server (SSR, typically UTC) and the
  // browser (SAST) — a text mismatch that trips React hydration (#418).
  return new Date(d).toLocaleDateString("en-ZA", { day: "2-digit", month: "long", year: "numeric", timeZone: "Africa/Johannesburg" })
}

function formatZAR(cents: number) {
  return `R ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function WriteOffCard({ writeOffAt, writeOffReason, approvedByName, outstandingAtWriteOff }: Props) {
  return (
    <div className="bg-white rounded-lg border border-red-200 overflow-hidden shadow-sm">
      {/* Header */}
      <div className="px-5 py-4 border-b border-red-100 flex items-center gap-3" style={{ background: "linear-gradient(135deg, #fff5f5 0%, #fff 100%)" }}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-red-100">
          <AlertTriangle className="h-4 w-4 text-red-600" />
        </div>
        <div className="flex-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-red-300">Loan Written Off</p>
          <p className="font-bold text-sm text-red-700 mt-0.5">Account Closed — Irrecoverable</p>
        </div>
        <div className="text-right">
          <p className="text-[10px] text-red-300">Written off</p>
          <p className="text-[12px] font-semibold text-red-600">{formatDate(writeOffAt)}</p>
        </div>
      </div>

      {/* Details */}
      <div className="px-5 py-4 space-y-3">
        {outstandingAtWriteOff !== undefined && outstandingAtWriteOff > 0 && (
          <div className="flex items-start gap-2 bg-red-50 rounded-md px-3 py-2.5">
            <AlertTriangle className="h-3.5 w-3.5 text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-red-400 font-semibold uppercase">Amount Written Off</p>
              <p className="text-base font-bold text-red-700 mt-0.5">{formatZAR(outstandingAtWriteOff)}</p>
            </div>
          </div>
        )}

        {approvedByName && (
          <div className="flex items-start gap-2">
            <UserCheck className="h-3.5 w-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-[10px] text-gray-400 font-semibold uppercase">Approved By</p>
              <p className="text-[12px] font-medium text-gray-700">{approvedByName}</p>
            </div>
          </div>
        )}

        <div className="flex items-start gap-2">
          <Calendar className="h-3.5 w-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-[10px] text-gray-400 font-semibold uppercase">Write-Off Date</p>
            <p className="text-[12px] font-medium text-gray-700">{formatDate(writeOffAt)}</p>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <FileText className="h-3.5 w-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-[10px] text-gray-400 font-semibold uppercase">Reason</p>
            <p className="text-[12px] text-gray-700 leading-relaxed">{writeOffReason}</p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-red-50 bg-red-50">
        <p className="text-[11px] text-red-500 font-medium">
          ⚠️ This loan has been permanently written off. No further collections activity should be initiated.
        </p>
      </div>
    </div>
  )
}
