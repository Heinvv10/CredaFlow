"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { X, Loader2, ClipboardList, Activity as ActivityIcon, User, MessageCircle, StickyNote, CalendarClock } from "lucide-react"
import { LeadTasksPanel } from "@/components/crm/LeadTasksPanel"
import { LeadDuplicateFlag } from "@/components/crm/LeadDuplicateFlag"
import { LeadEditForm } from "@/components/crm/LeadEditForm"
import { LeadOutreachTab } from "@/components/crm/LeadOutreachTab"
import { LeadNotesTab } from "@/components/crm/LeadNotesTab"
import { LeadActivityTab } from "@/components/crm/LeadActivityTab"
import { LeadAppointmentTab } from "@/components/crm/LeadAppointmentTab"
import { LeadModalFooter } from "@/components/crm/LeadModalFooter"
import { LeadModalHighlights } from "@/components/crm/LeadModalHighlights"
import { buildLeadPatch, isLeadFormDirty, leadToFormState, type LeadFormState } from "@/lib/crm/lead-edit-form"
import type { TabKey } from "@/lib/crm/lead-modal-url"

// Client component: imports ONLY prisma-free modules — except the TYPE-ONLY
// import of LeadDetailBundle, which is erased at compile time and keeps this
// shape derived from the server's single bundle assembly instead of a
// hand-copied duplicate. Never turn it into a value import: that would pull
// prisma into the browser bundle, which only `npm run build` catches.
import type { LeadDetailBundle } from "@/lib/crm/lead-detail-bundle"

type Bundle = LeadDetailBundle & {
  permissions: { canReassign: boolean; canCreateTasks: boolean; canManageTasks: boolean; canWriteActivity: boolean }
  currentUserId: string
  agentName: string
}

export type { TabKey } from "@/lib/crm/lead-modal-url"
const TABS: { key: TabKey; label: string; icon: typeof User }[] = [
  { key: "details", label: "Details", icon: User },
  { key: "outreach", label: "Outreach", icon: MessageCircle },
  { key: "appointment", label: "Appointment", icon: CalendarClock },
  { key: "notes", label: "Notes", icon: StickyNote },
  { key: "activity", label: "Activity", icon: ActivityIcon },
  { key: "tasks", label: "Tasks", icon: ClipboardList },
]

/**
 * GHL-style centred edit modal for a lead, opened from the pipeline. `leadId`
 * null = closed. Fetches the record bundle on open so the board payload stays
 * light (one lead's detail, lazily, not every lead's up front).
 *
 * The Details tab is an editable form saved through PATCH /api/crm/leads/[id]
 * (the same route the full page uses — CREDIT_OFFICER-gated, tenant-scoped,
 * audited). Below that bar the form is read-only. Stage editing here covers only
 * the plain transitions; Convert / Mark-lost stay on the full page.
 */
export function LeadSlideOver({ leadId, onClose, initialTab = "details", onTabChange }: {
  leadId: string | null
  onClose: () => void
  /** Tab to land on when opening — the card quick-action icons deep-open a tab. */
  initialTab?: TabKey
  /** Fires on every tab switch — the board mirrors it into the ?tab= URL param. */
  onTabChange?: (tab: TabKey) => void
}) {
  const [bundle, setBundle] = useState<Bundle | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TabKey>("details")
  const [form, setForm] = useState<LeadFormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // The id of the most recent load request. A response for anything other than
  // the currently-requested lead is stale (rapid deep-link/back-forward
  // navigation leaves earlier fetches in flight) and must not overwrite state.
  const requestedIdRef = useRef<string | null>(null)

  // `silent` refreshes the bundle without the full-panel spinner.
  // `preserveDirtyForm` keeps an in-progress Details edit — set ONLY by
  // tab-mutation refreshes (a note/task/pin change on another tab); a
  // post-save reload must re-seed so the form shows the normalised (trimmed /
  // rounded) stored values, never a raw draft that would read as still-dirty.
  const load = useCallback(async (id: string, opts?: { silent?: boolean; preserveDirtyForm?: boolean }) => {
    requestedIdRef.current = id
    if (!opts?.silent) setLoading(true)
    setError(null)
    try {
      // encodeURIComponent: defense in depth — the deep-link path validates
      // the id shape, but this fetch must never be path-confusable even if a
      // caller slips through with hostile text.
      const res = await fetch(`/api/crm/leads/${encodeURIComponent(id)}/detail`)
      if (requestedIdRef.current !== id) return // a newer lead was requested
      if (!res.ok) {
        setError(res.status === 404 ? "This lead no longer exists." : "Could not load this lead.")
        setBundle(null)
        return
      }
      const data = (await res.json()) as Bundle
      if (requestedIdRef.current !== id) return
      setBundle(data)
      setForm((prev) =>
        opts?.preserveDirtyForm && prev && isLeadFormDirty(leadToFormState(data.lead), prev)
          ? prev
          : leadToFormState(data.lead)
      )
    } catch {
      if (requestedIdRef.current !== id) return
      setError("Could not load this lead.")
      setBundle(null)
    } finally {
      if (!opts?.silent && requestedIdRef.current === id) setLoading(false)
    }
  }, [])

  // Two effects on purpose: the parent echoes tab switches back through
  // initialTab (URL mirroring), and a tab switch must NOT re-run load() —
  // that would reset the form and discard unsaved edits.
  useEffect(() => {
    if (leadId) {
      setSaveError(null)
      void load(leadId)
    } else {
      setBundle(null)
      setForm(null)
      setError(null)
    }
  }, [leadId, load])

  useEffect(() => {
    if (leadId) setTab(initialTab)
  }, [leadId, initialTab])

  useEffect(() => {
    if (!leadId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [leadId, onClose])

  if (!leadId) return null

  const lead = bundle?.lead
  const canEdit = bundle?.permissions.canReassign ?? false
  const dirty = !!(bundle && form && isLeadFormDirty(leadToFormState(bundle.lead), form))

  const set = <K extends keyof LeadFormState>(k: K, v: LeadFormState[K]) =>
    setForm((f) => (f ? { ...f, [k]: v } : f))

  // A note/task/pin change on another tab: refresh the bundle silently AND
  // keep any in-progress Details edit (the mutation isn't the form's save).
  const refresh = () => { if (leadId) void load(leadId, { silent: true, preserveDirtyForm: true }) }

  const handleSave = async () => {
    if (!lead || !form || !bundle) return
    // Dirty fields only — resending unchanged status/assignedToId trips the
    // route's CONVERTED/LOST and isAssignableStaff guards (see lead-edit-form.ts).
    const patch = buildLeadPatch(leadToFormState(bundle.lead), form)
    if (!patch.ok) {
      setSaveError(patch.error)
      return
    }
    if (Object.keys(patch.payload).length === 0) return
    setSaving(true)
    setSaveError(null)
    try {
      const res = await fetch(`/api/crm/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch.payload),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setSaveError(body.error ?? "Could not save changes.")
        return
      }
      await load(lead.id, { silent: true })
    } catch {
      setSaveError("Could not save changes.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop. role="dialog" goes on the PANEL below — globals.css paints
          `.cf-app-surface [role="dialog"]` with an opaque bg !important, so on
          the full-screen container it would black out the whole board. */}
      <button aria-label="Close" onClick={onClose} className="absolute inset-0 h-full w-full cursor-default bg-black/50" />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Edit lead"
        className="relative flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-gray-200 px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-gray-900">
              {lead ? `Edit "${lead.firstName} ${lead.lastName}"` : "Lead"}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">Add and edit lead details, activity and tasks.</p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {loading && (
          <div className="flex flex-1 items-center justify-center py-24 text-gray-400"><Loader2 className="h-6 w-6 animate-spin" /></div>
        )}
        {error && !loading && (
          <div className="flex flex-1 items-center justify-center px-6 py-24 text-center text-sm text-gray-600">{error}</div>
        )}

        {bundle && lead && form && !loading && (
          <>
            <LeadModalHighlights lead={lead} form={form} staff={bundle.staff} />
            <div className="flex min-h-0 flex-1">
              {/* Left tab-nav */}
              <nav className="flex w-44 flex-none flex-col gap-1 border-r border-gray-200 bg-gray-50 p-3">
                {TABS.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => { setTab(key); onTabChange?.(key) }}
                    className={`flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${
                      tab === key ? "bg-white font-medium text-gray-900 shadow-sm" : "text-gray-600 hover:bg-white/60"
                    }`}
                  >
                    <Icon className="h-4 w-4 flex-none" />
                    {label}
                    {key === "tasks" && bundle.tasks.length > 0 && (
                      <span className="ml-auto rounded-full bg-gray-200 px-1.5 text-[11px] text-gray-700">{bundle.tasks.length}</span>
                    )}
                  </button>
                ))}
              </nav>

              {/* Content */}
              <div className="min-w-0 flex-1 overflow-y-auto p-6">
                {tab === "details" && (
                  <div className="space-y-5">
                    <LeadDuplicateFlag count={bundle.duplicateCount} truncated={bundle.duplicatesTruncated} href={`/crm/leads/${lead.id}/duplicates`} />
                    <LeadEditForm lead={lead} staff={bundle.staff} form={form} initial={leadToFormState(bundle.lead)} canEdit={canEdit} onChange={set} />
                  </div>
                )}

                {tab === "outreach" && (
                  <LeadOutreachTab
                    lead={lead}
                    hasContact={bundle.hasContact}
                    cannedReplies={bundle.cannedReplies}
                    agentName={bundle.agentName}
                  />
                )}

                {tab === "appointment" && (
                  <LeadAppointmentTab
                    key={lead.id}
                    leadId={lead.id}
                    status={lead.status}
                    callbackDate={lead.callbackDate}
                    callbackNotes={lead.callbackNotes}
                    canSchedule={bundle.permissions.canWriteActivity}
                    onChanged={refresh}
                  />
                )}

                {tab === "notes" && (
                  <LeadNotesTab
                    key={lead.id}
                    leadId={lead.id}
                    activities={bundle.activities}
                    canWrite={bundle.permissions.canWriteActivity}
                    onChanged={refresh}
                  />
                )}

                {tab === "activity" && (
                  <LeadActivityTab
                    activities={bundle.activities}
                    commsMessages={bundle.commsMessages}
                    canPin={bundle.permissions.canWriteActivity}
                    onChanged={refresh}
                  />
                )}

                {tab === "tasks" && (
                  <LeadTasksPanel
                    leadId={lead.id}
                    tasks={bundle.tasks}
                    staff={bundle.staff}
                    canCreate={bundle.permissions.canCreateTasks}
                    canManage={bundle.permissions.canManageTasks}
                    currentUserId={bundle.currentUserId}
                    onChanged={refresh}
                  />
                )}
              </div>
            </div>

            <LeadModalFooter lead={lead} canEdit={canEdit} dirty={dirty} saving={saving} saveError={saveError} onCancel={onClose} onSave={handleSave} />
          </>
        )}
      </div>
    </div>
  )
}
