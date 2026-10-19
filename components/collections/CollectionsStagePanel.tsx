"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { CheckCircle, ChevronRight, AlertTriangle, Scale, Handshake, Briefcase, XCircle } from "lucide-react"
import { ArrangementForm } from "./ArrangementForm"
import { AttorneyReferralForm } from "./AttorneyReferralForm"
import { WriteOffForm } from "./WriteOffForm"
import { ArrangementSummary } from "./ArrangementSummary"
import { formatZAR } from "@/lib/utils"
import { section129HintText, type Section129Block } from "@/lib/collections/section129-hint"

type Stage =
  | "NONE"
  | "SOFT_REMINDER"
  | "FORMAL_REMINDER"
  | "SECTION_129_SENT"
  | "PAYMENT_ARRANGEMENT"
  | "ATTORNEY_REFERRED"
  | "WRITTEN_OFF"

interface ArrangementData {
  agreedAmount: number
  frequency: string
  startDate: string
  endDate: string
  notes?: string
  status?: string
}

interface ReferralData {
  firmName: string
  contactPerson?: string
  contactPhone?: string
  contactEmail?: string
  matterNumber?: string
  notes?: string
}

interface Props {
  loanId: string
  currentStage: Stage
  daysInArrears: number
  arrearsAmount: number
  existingArrangement: ArrangementData | null
  existingReferral: ReferralData | null
  writeOffPending?: boolean
  readOnlyReason?: string
  /** Why the S.129 action is disabled (same reason as its button tooltip); unset when it is available. */
  section129Unavailable?: Section129Block
}

const STAGE_CONFIG: Record<Stage, { label: string; color: string; bg: string; icon: React.ElementType }> = {
  NONE:                { label: "No Action", color: "#6B7280", bg: "#F3F4F6", icon: CheckCircle },
  SOFT_REMINDER:       { label: "Soft Reminder Sent", color: "#3B82F6", bg: "#DBEAFE", icon: AlertTriangle },
  FORMAL_REMINDER:     { label: "Formal Reminder Sent", color: "#F59E0B", bg: "#FEF3C7", icon: AlertTriangle },
  SECTION_129_SENT:    { label: "Section 129 Issued", color: "#EF4444", bg: "#FEE2E2", icon: Scale },
  PAYMENT_ARRANGEMENT: { label: "Payment Arrangement", color: "#10B981", bg: "#D1FAE5", icon: Handshake },
  ATTORNEY_REFERRED:   { label: "Referred to Attorney", color: "#8B5CF6", bg: "#EDE9FE", icon: Briefcase },
  WRITTEN_OFF:         { label: "Written Off", color: "#1F2937", bg: "#F3F4F6", icon: XCircle },
}

const STAGE_ORDER: Stage[] = [
  "NONE", "SOFT_REMINDER", "FORMAL_REMINDER", "SECTION_129_SENT",
  "PAYMENT_ARRANGEMENT", "ATTORNEY_REFERRED", "WRITTEN_OFF",
]

export function CollectionsStagePanel({
  loanId,
  currentStage,
  daysInArrears,
  arrearsAmount,
  existingArrangement,
  existingReferral,
  writeOffPending = false,
  readOnlyReason,
  section129Unavailable,
}: Props) {
  const router = useRouter()
  const [loading, setLoading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showArrangementForm, setShowArrangementForm] = useState(false)
  const [showReferralForm, setShowReferralForm] = useState(false)
  const [showWriteOffForm, setShowWriteOffForm] = useState(false)

  const cfg = STAGE_CONFIG[currentStage]
  const StageIcon = cfg.icon
  const isWrittenOff = currentStage === "WRITTEN_OFF"

  async function advanceStage(stage: Stage, notes?: string) {
    setLoading(stage)
    setError(null)
    try {
      const res = await fetch(`/api/loans/${loanId}/collections-stage`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage, notes }),
      })
      if (!res.ok) { const d = await res.json() as { error?: string }; setError(d.error ?? "Failed"); return }
      router.refresh()
    } catch {
      setError("Request failed")
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-100 shadow-sm overflow-hidden">
      {/* Header: current stage */}
      <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: cfg.bg }}>
            <StageIcon className="h-4 w-4" style={{ color: cfg.color }} />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Collections Stage</p>
            <p className="font-semibold text-gray-900 text-sm mt-0.5" style={{ color: cfg.color }}>{cfg.label}</p>
          </div>
        </div>
        {!isWrittenOff && (
          <span className="text-[11px] text-gray-400">{daysInArrears}DPD · <span className="whitespace-nowrap">{formatZAR(arrearsAmount)}</span></span>
        )}
      </div>

      {/* Stage progress bar */}
      <div className="px-5 py-3 flex items-center gap-1">
        {STAGE_ORDER.filter(s => s !== "NONE").map((s, i) => {
          const idx = STAGE_ORDER.indexOf(currentStage)
          const thisIdx = STAGE_ORDER.indexOf(s)
          const done = thisIdx <= idx
          return (
            <div key={s} className="flex items-center gap-1 flex-1">
              <div className="h-1.5 flex-1 rounded-full" style={{ backgroundColor: done ? cfg.color : "#E5E7EB" }} />
              {i < STAGE_ORDER.filter(s => s !== "NONE").length - 1 && (
                <ChevronRight className="h-3 w-3 text-gray-300 flex-shrink-0" />
              )}
            </div>
          )
        })}
      </div>

      {/* Action buttons */}
      {!isWrittenOff && !readOnlyReason && (
        <div className="px-5 py-4 space-y-2">
          {currentStage === "NONE" && (
            <button onClick={() => advanceStage("SOFT_REMINDER")} disabled={loading !== null}
              className="w-full flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium text-white disabled:opacity-50 transition-colors"
              style={{ backgroundColor: "#3B82F6" }}>
              <AlertTriangle className="h-4 w-4" />
              {loading === "SOFT_REMINDER" ? "Sending…" : "Send Soft Reminder (WA)"}
            </button>
          )}

          {currentStage === "SOFT_REMINDER" && (
            <button onClick={() => advanceStage("FORMAL_REMINDER")} disabled={loading !== null}
              className="w-full flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: "#F59E0B" }}>
              <AlertTriangle className="h-4 w-4" />
              {loading === "FORMAL_REMINDER" ? "Sending…" : "Issue Formal Reminder"}
            </button>
          )}

          {(currentStage === "SOFT_REMINDER" || currentStage === "FORMAL_REMINDER") && !showArrangementForm && (
            <button onClick={() => { setShowArrangementForm(true); setShowReferralForm(false) }}
              className="w-full flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium border transition-colors"
              style={{ borderColor: "#10B981", color: "#10B981" }}>
              <Handshake className="h-4 w-4" />
              Record Payment Arrangement
            </button>
          )}

          {currentStage === "FORMAL_REMINDER" && !showArrangementForm && (
            <div className="w-full flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium bg-red-50 text-red-700 border border-red-100">
              <Scale className="h-4 w-4 flex-shrink-0" />
              {section129Unavailable
                ? section129HintText(section129Unavailable)
                : <>Use the &ldquo;S.129 Notice&rdquo; action above to issue Section 129 — the stage updates automatically once the notice is sent.</>}
            </div>
          )}

          {currentStage === "SECTION_129_SENT" && (
            <>
              {!showArrangementForm && (
                <button onClick={() => { setShowArrangementForm(true); setShowReferralForm(false) }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium border"
                  style={{ borderColor: "#10B981", color: "#10B981" }}>
                  <Handshake className="h-4 w-4" />
                  Record Payment Arrangement
                </button>
              )}
              {!showReferralForm && (
                <button onClick={() => { setShowReferralForm(true); setShowArrangementForm(false) }}
                  className="w-full flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium border"
                  style={{ borderColor: "#8B5CF6", color: "#8B5CF6" }}>
                  <Briefcase className="h-4 w-4" />
                  Refer to Attorney
                </button>
              )}
            </>
          )}

          {currentStage === "PAYMENT_ARRANGEMENT" && !showReferralForm && (
            <button onClick={() => { setShowReferralForm(true); setShowArrangementForm(false) }}
              className="w-full flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium border"
              style={{ borderColor: "#8B5CF6", color: "#8B5CF6" }}>
              <Briefcase className="h-4 w-4" />
              Arrangement Broken — Refer to Attorney
            </button>
          )}

          {currentStage === "ATTORNEY_REFERRED" && !showWriteOffForm && !writeOffPending && (
            <button onClick={() => setShowWriteOffForm(true)}
              className="w-full flex items-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium border border-red-300 text-red-600 hover:bg-red-50">
              <XCircle className="h-4 w-4" />
              Write Off Account
            </button>
          )}

          {showArrangementForm && (
            <ArrangementForm loanId={loanId} onCancel={() => setShowArrangementForm(false)} />
          )}
          {showReferralForm && (
            <AttorneyReferralForm loanId={loanId} onCancel={() => setShowReferralForm(false)} />
          )}
          {showWriteOffForm && (
            <WriteOffForm loanId={loanId} onCancel={() => setShowWriteOffForm(false)} />
          )}

          {error && (
            <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded border border-red-100">{error}</p>
          )}
        </div>
      )}

      {!isWrittenOff && readOnlyReason && (
        <div className="mx-5 mb-4 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-500">
          Collections actions disabled: {readOnlyReason}.
        </div>
      )}

      {existingArrangement && (
        <ArrangementSummary loanId={loanId} existingArrangement={existingArrangement} />
      )}

      {existingReferral && (
        <div className="px-5 py-3 border-t border-gray-50 bg-purple-50">
          <p className="text-[11px] font-semibold text-purple-700 uppercase tracking-wide mb-1">Attorney Referral</p>
          <p className="text-sm text-purple-800 font-medium">{existingReferral.firmName}</p>
          {existingReferral.contactPerson && <p className="text-xs text-purple-600">{existingReferral.contactPerson} · {existingReferral.contactPhone}</p>}
          {existingReferral.matterNumber && <p className="text-xs text-purple-600 font-mono">Matter: {existingReferral.matterNumber}</p>}
        </div>
      )}
    </div>
  )
}
