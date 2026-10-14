"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { Phone, Mail, Calendar, UserCheck, Trash2, Flame, MessageCircle, RotateCcw } from "lucide-react"
import { addLeadActivity, updateLeadStatus, resetStrandedConvertedLead } from "@/app/actions/crm"
import { CallbackModal } from "@/components/crm/CallbackModal"
import { LostReasonModal } from "@/components/crm/LostReasonModal"
import { SendWhatsAppModal } from "@/components/crm/SendWhatsAppModal"
import { MessageClientButton } from "@/components/messaging/MessageClientButton"
import { ActivityRow, MessageRow, timeAgo, SAST_TIME_ZONE } from "@/components/crm/LeadTimelineRow"
import { LeadOwnerSelect } from "@/components/crm/LeadOwnerSelect"
import { LeadOutreachButtons } from "@/components/crm/LeadOutreachButtons"
import { LeadTasksPanel, type LeadTask } from "@/components/crm/LeadTasksPanel"
import { LeadDuplicateFlag } from "@/components/crm/LeadDuplicateFlag"
import { mergeLeadTimeline, type TimelineMessageInput } from "@/lib/crm/lead-timeline"
import { type AssignableStaff } from "@/lib/crm/lead-assignment"
import { leadOutreachEligibility } from "@/lib/crm/lead-outreach-eligibility"
import { canConvertLead, leadConversionState } from "@/lib/crm/lead-conversion"
import { getScoreTier } from "@/lib/lead-scoring"

type Activity = {
  id: string
  type: string
  subject: string
  notes: string | null
  createdAt: Date
}

type Lead = {
  id: string
  firstName: string
  lastName: string
  email: string | null
  phone: string
  source: string
  status: string
  notes: string | null
  assignedToId: string | null
  requestedAmount: number | null
  leadScore: number | null
  callbackDate: Date | null
  callbackNotes: string | null
  lostReason: string | null
  convertedToClientId: string | null
  convertedToApplicationId: string | null
  conversionRecoveryRequired: boolean
  createdAt: Date
  activities: Activity[]
}

const STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL_SENT", "CONVERTED", "LOST"]
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  NEW: { bg: "#DBEAFE", text: "#1E40AF" },
  CONTACTED: { bg: "#FEF3C7", text: "#92400E" },
  QUALIFIED: { bg: "#D1FAE5", text: "#065F46" },
  PROPOSAL_SENT: { bg: "#EDE9FE", text: "#5B21B6" },
  CONVERTED: { bg: "#DCFCE7", text: "#166534" },
  INCOMPLETE: { bg: "#FEF3C7", text: "#92400E" },
  STRANDED: { bg: "#FFEDD5", text: "#9A3412" },
  LOST: { bg: "#FEE2E2", text: "#991B1B" },
}

const ACTIVITY_TYPES = ["CALL", "EMAIL", "WHATSAPP", "MEETING", "NOTE", "FOLLOW_UP", "LOAN_OFFER", "INSURANCE_OFFER"]

const LOST_REASON_LABELS: Record<string, string> = {
  TOO_EXPENSIVE: "Too Expensive", WENT_ELSEWHERE: "Went Elsewhere",
  NOT_QUALIFIED: "Not Qualified", NO_RESPONSE: "No Response", PRODUCT_MISMATCH: "Product Mismatch",
}

// SAST calendar day as a sortable "YYYY-MM-DD" string. `setHours(0,0,0,0)`
// would derive "today" from the runtime's LOCAL wall clock — server (UTC)
// and browser (SAST) disagree on where midnight falls, so the Today/
// Tomorrow/full-date branch below could differ between SSR and hydration
// even with the display formatting pinned to a timeZone.
function sastDateOnly(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: SAST_TIME_ZONE })
}

function formatCallbackDate(date: Date) {
  const d = new Date(date)
  const now = new Date()
  const dDay = sastDateOnly(d)
  const todayDay = sastDateOnly(now)
  const tomorrowDay = sastDateOnly(new Date(now.getTime() + 86_400_000))
  if (dDay === todayDay) return `Today at ${d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: SAST_TIME_ZONE })}`
  if (dDay === tomorrowDay) return `Tomorrow at ${d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", timeZone: SAST_TIME_ZONE })}`
  return d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: SAST_TIME_ZONE })
}

export function LeadDetailClient({
  lead,
  hasContact,
  cannedReplies,
  commsMessages,
  staff,
  canReassign,
  agentName,
  tasks,
  canCreateTasks,
  canManageTasks,
  canWriteActivity,
  canConvert,
  currentUserId,
  duplicateCount,
  duplicatesTruncated,
}: {
  lead: Lead
  hasContact: boolean
  cannedReplies: { id: string; title: string; body: string }[]
  commsMessages: TimelineMessageInput[]
  staff: AssignableStaff[]
  canReassign: boolean
  /** Signing name for the outreach preview — resolved server-side from the session. */
  agentName: string
  tasks: LeadTask[]
  canCreateTasks: boolean
  /** May act on ANY task — mirrors PATCH's `canManage`, not the POST bar. */
  canManageTasks: boolean
  /** May change stage / log activity — CREDIT_OFFICER and above, like the actions. */
  canWriteActivity: boolean
  /** May convert a lead or reset a stranded conversion — mirrors the convert
   *  route and resetStrandedConvertedLead (CREDIT_OFFICER). */
  canConvert: boolean
  /** Session user id — the Tasks panel decides completion per row from it. */
  currentUserId: string
  /** Leads sharing this one's phone or email. 0 renders no banner. */
  duplicateCount: number
  /** The duplicate scan hit its cap — 0 then means "unknown", not "none". */
  duplicatesTruncated: boolean
}) {
  const router = useRouter()
  const conversionState = leadConversionState(
    lead.status,
    lead.convertedToClientId,
    lead.convertedToApplicationId,
    lead.conversionRecoveryRequired,
  )
  const conversionLocked = conversionState !== "OPEN"
  const displayedStatus = conversionState === "COMPLETE"
    ? "CONVERTED"
    : conversionState === "INCOMPLETE" || conversionState === "STRANDED"
      ? conversionState
      : lead.status
  const [status, setStatus] = useState(displayedStatus)
  const [showActivityForm, setShowActivityForm] = useState(false)
  const [showCallbackModal, setShowCallbackModal] = useState(false)
  const [showLostModal, setShowLostModal] = useState(false)
  const [showWaModal, setShowWaModal] = useState(false)
  const [activityType, setActivityType] = useState("CALL")
  const [activitySubject, setActivitySubject] = useState("")
  const [activityNotes, setActivityNotes] = useState("")
  const [savingActivity, setSavingActivity] = useState(false)
  const [activityError, setActivityError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [resettingConversion, setResettingConversion] = useState(false)

  const outreachEligibility = leadOutreachEligibility(lead)
  const timeline = mergeLeadTimeline(lead.activities, commsMessages)
  const sc = STATUS_COLORS[status] ?? { bg: "#F3F4F6", text: "#374151" }
  const scoreTier = lead.leadScore !== null ? getScoreTier(lead.leadScore) : null
  const callbackOverdue = lead.callbackDate && new Date(lead.callbackDate) < new Date()
  const strandedConversion = conversionState === "STRANDED"
  const incompleteConversion = conversionState === "INCOMPLETE"

  const handleStatusChange = async (newStatus: string) => {
    if (conversionLocked) return
    if (newStatus === "CONVERTED") { router.push(`/crm/leads/${lead.id}/convert`); return }
    if (newStatus === "LOST") { setShowLostModal(true); return }
    setStatusError(null)
    setStatus(newStatus)
    try {
      const result = await updateLeadStatus(lead.id, newStatus)
      if (!result.ok) {
        setStatus(lead.status)
        setStatusError(result.error)
        return
      }
      router.refresh()
    } catch (err) {
      setStatus(lead.status)
      setStatusError(err instanceof Error ? err.message : "Could not change status")
    }
  }

  const handleResetConversion = async () => {
    setResettingConversion(true)
    try {
      await resetStrandedConvertedLead(lead.id)
    } finally {
      setResettingConversion(false)
    }
  }

  const handleAddActivity = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activitySubject.trim()) return
    setSavingActivity(true)
    setActivityError(null)
    try {
      const result = await addLeadActivity({ leadId: lead.id, type: activityType, subject: activitySubject, notes: activityNotes || undefined })
      if (!result.ok) {
        setActivityError(result.error)
        return
      }
      setShowActivityForm(false)
      setActivitySubject("")
      setActivityNotes("")
      router.refresh()
    } finally {
      setSavingActivity(false)
    }
  }

  return (
    <>
      {showCallbackModal && <CallbackModal leadId={lead.id} onClose={() => setShowCallbackModal(false)} />}
      {showLostModal && <LostReasonModal leadId={lead.id} onClose={() => { setShowLostModal(false); router.refresh() }} />}
      {lead.convertedToClientId && (
        <SendWhatsAppModal
          clientId={lead.convertedToClientId}
          clientName={`${lead.firstName} ${lead.lastName}`}
          phone={lead.phone}
          isOpen={showWaModal}
          onClose={() => setShowWaModal(false)}
        />
      )}

      <div className="flex gap-6">
        {/* Main content */}
        <div className="flex-1 min-w-0 space-y-5">
          <LeadDuplicateFlag
            count={duplicateCount}
            truncated={duplicatesTruncated}
            href={`/crm/leads/${lead.id}/duplicates`}
          />

          {/* Callback alert */}
          {lead.callbackDate && (
            <div className={`rounded-lg border px-4 py-3 flex items-start gap-3 ${callbackOverdue ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200"}`}>
              <Calendar className={`h-4 w-4 flex-shrink-0 mt-0.5 ${callbackOverdue ? "text-red-500" : "text-amber-500"}`} />
              <div>
                <p className={`text-sm font-semibold ${callbackOverdue ? "text-red-700" : "text-amber-700"}`}>
                  {callbackOverdue ? "⚠️ Overdue callback" : "📅 Scheduled callback"} — {formatCallbackDate(lead.callbackDate)}
                </p>
                {lead.callbackNotes && <p className="text-xs text-gray-600 mt-0.5">{lead.callbackNotes}</p>}
              </div>
            </div>
          )}

          {/* Lost reason banner */}
          {status === "LOST" && lead.lostReason && (
            <div className="rounded-lg border border-red-100 bg-red-50 px-4 py-3">
              <p className="text-sm text-red-700">
                <span className="font-semibold">Lost reason:</span> {LOST_REASON_LABELS[lead.lostReason] ?? lead.lostReason}
              </p>
            </div>
          )}

          {/* Lead info card */}
          <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-4">
                <div
                  className="w-14 h-14 rounded-full flex items-center justify-center text-white text-lg font-bold flex-shrink-0"
                  style={{ background: "linear-gradient(135deg, #4338CA 0%, #4F46E5 100%)" }}
                >
                  {lead.firstName[0]}{lead.lastName[0]}
                </div>
                <div>
                  <h1 className="text-xl font-bold text-gray-900">{lead.firstName} {lead.lastName}</h1>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded text-[11px] font-semibold" style={{ backgroundColor: sc.bg, color: sc.text }}>
                      {status.replace(/_/g, " ")}
                    </span>
                    <span className="text-xs text-gray-400">{lead.source.replace(/_/g, " ")}</span>
                    {scoreTier && lead.leadScore !== null && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-bold"
                        style={{ backgroundColor: scoreTier.bg, color: scoreTier.color }}>
                        <Flame className="h-3 w-3" />
                        {scoreTier.label} {lead.leadScore}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <UserCheck className="h-4 w-4 text-gray-400" />
                <span className="text-xs text-gray-500">Added {timeAgo(lead.createdAt)}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="flex items-center gap-2 text-gray-600"><Phone className="h-4 w-4 text-gray-400" />{lead.phone}</div>
              {lead.email && <div className="flex items-center gap-2 text-gray-600"><Mail className="h-4 w-4 text-gray-400" />{lead.email}</div>}
            </div>
            {lead.notes && <p className="mt-4 text-sm text-gray-600 bg-gray-50 rounded-md p-3">{lead.notes}</p>}
          </div>

          {/* Status pipeline */}
          {canWriteActivity && <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Move Stage</p>
            <div className="flex flex-wrap gap-2">
              {STATUSES.map((s) => {
                const c = STATUS_COLORS[s]
                const isActive = status === s
                return (
                  <button
                    key={s}
                    onClick={() => handleStatusChange(s)}
                    disabled={conversionLocked}
                    className="px-3 py-1.5 rounded-md text-xs font-semibold border-2 transition-all disabled:cursor-not-allowed disabled:opacity-60"
                    style={isActive ? { backgroundColor: c.bg, color: c.text, borderColor: c.text } : { backgroundColor: "transparent", color: "#9CA3AF", borderColor: "#E5E7EB" }}
                  >
                    {s.replace(/_/g, " ")}
                  </button>
                )
              })}
            </div>
            {statusError && <p className="mt-3 text-xs text-red-600">{statusError}</p>}
          </div>}

          <LeadTasksPanel
            leadId={lead.id}
            tasks={tasks}
            staff={staff}
            canCreate={canCreateTasks}
            canManage={canManageTasks}
            currentUserId={currentUserId}
          />

          {/* Activity timeline */}
          <div className="bg-white rounded-lg border border-gray-100 shadow-sm">
            <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
              <h2 className="font-semibold text-gray-900 text-sm">Activity Timeline</h2>
              {canWriteActivity && <button
                onClick={() => setShowActivityForm(!showActivityForm)}
                className="text-xs font-medium px-3 py-1.5 rounded-md text-white"
                style={{ backgroundColor: "#4338CA" }}
              >
                + Add Activity
              </button>}
            </div>

            {showActivityForm && (
              <form onSubmit={handleAddActivity} className="px-5 py-4 border-b border-gray-50 bg-gray-50 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Type</label>
                    <select value={activityType} onChange={(e) => setActivityType(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm bg-white focus:outline-none">
                      {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-gray-600 mb-1">Subject *</label>
                    <input value={activitySubject} onChange={(e) => setActivitySubject(e.target.value)} className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none" placeholder="e.g. Called client" />
                  </div>
                </div>
                <textarea value={activityNotes} onChange={(e) => setActivityNotes(e.target.value)} rows={2} className="w-full px-3 py-2 border border-gray-200 rounded-md text-sm focus:outline-none resize-none" placeholder="Notes..." />
                <div className="flex items-center gap-2">
                  <button type="submit" disabled={savingActivity} className="px-4 py-1.5 rounded-md text-white text-sm font-medium disabled:opacity-60" style={{ backgroundColor: "#4338CA" }}>
                    {savingActivity ? "Saving..." : "Save"}
                  </button>
                  <button type="button" onClick={() => setShowActivityForm(false)} className="px-3 py-1.5 rounded-md border border-gray-200 text-sm text-gray-600">Cancel</button>
                  {activityError && <span className="text-xs text-red-600">{activityError}</span>}
                </div>
              </form>
            )}

            <div className="divide-y divide-gray-50">
              {timeline.length === 0 && !showActivityForm && (
                <p className="px-5 py-8 text-center text-sm text-gray-400">No activities yet — add the first one above</p>
              )}
              {timeline.map((entry) => (
                entry.kind === "activity"
                  ? <ActivityRow key={`a-${entry.id}`} entry={entry} />
                  : <MessageRow key={`m-${entry.id}`} entry={entry} />
              ))}
            </div>
          </div>
        </div>

        {/* Side actions */}
        <div className="w-56 flex-shrink-0 space-y-3">
          <LeadOwnerSelect leadId={lead.id} assignedToId={lead.assignedToId} staff={staff} canReassign={canReassign} />
          {/* No contact ⇒ nothing to send to. Everything else (closed lead, no
              loan enquiry on file) is decided by leadOutreachEligibility and
              re-checked server-side — this only decides whether to render the
              card at all. */}
          {hasContact && (
            <LeadOutreachButtons
              leadId={lead.id}
              eligibility={outreachEligibility}
              leadFirstName={lead.firstName}
              agentName={agentName}
            />
          )}
          <div className="bg-white rounded-lg border border-gray-100 shadow-sm p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-3">Actions</p>
            <div className="space-y-2">
              {hasContact && (
                <MessageClientButton
                  clientId={lead.id}
                  clientName={`${lead.firstName} ${lead.lastName}`}
                  cannedReplies={cannedReplies}
                  apiBase={`/api/crm/leads/${lead.id}`}
                  fullWidth
                />
              )}
              {canWriteActivity && !conversionLocked && lead.status !== "LOST" && (
                <button
                  onClick={() => setShowCallbackModal(true)}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm font-medium border border-amber-200 text-amber-700 hover:bg-amber-50 transition-colors"
                >
                  <Calendar className="h-4 w-4" />
                  Schedule Callback
                </button>
              )}
              {canConvert && canConvertLead(
                lead.status,
                lead.convertedToClientId,
                lead.convertedToApplicationId,
                lead.conversionRecoveryRequired,
              ) && (
                <Link href={`/crm/leads/${lead.id}/convert`} className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm font-medium text-white" style={{ backgroundColor: "#16A085" }}>
                  <UserCheck className="h-4 w-4" />
                  Convert to Client
                </Link>
              )}
              {canConvert && strandedConversion && (
                <button
                  onClick={handleResetConversion}
                  disabled={resettingConversion}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm font-medium border border-amber-200 text-amber-700 hover:bg-amber-50 transition-colors disabled:opacity-60"
                >
                  <RotateCcw className="h-4 w-4" />
                  {resettingConversion ? "Resetting…" : "Reset & Retry Conversion"}
                </button>
              )}
              {incompleteConversion && (
                <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Conversion evidence is incomplete. The exact client/application link must be repaired before this lead can progress.{" "}
                  {canConvert && <Link href={`/crm/leads/${lead.id}/convert`} className="font-semibold underline">
                    Open repair view
                  </Link>}
                </div>
              )}
              {canWriteActivity && !conversionLocked && lead.status !== "LOST" && (
                <button
                  onClick={() => setShowLostModal(true)}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm font-medium border border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                  Mark as Lost
                </button>
              )}
              {lead.convertedToClientId && (
                <Link
                  href={`/clients/${lead.convertedToClientId}`}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm font-medium text-white"
                  style={{ backgroundColor: "#16A085" }}
                >
                  <UserCheck className="h-4 w-4" />
                  View Client
                </Link>
              )}
              {lead.convertedToClientId && (
                <button
                  onClick={() => setShowWaModal(true)}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-sm font-medium border border-green-200 text-green-700 hover:bg-green-50 transition-colors"
                >
                  <MessageCircle className="h-4 w-4" style={{ color: "#25D366" }} />
                  WhatsApp Client
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
