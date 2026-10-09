"use client"

import { useState } from "react"
import { resolveLeadOwner, type AssignableStaff } from "@/lib/crm/lead-assignment"
import { EDITABLE_STAGES, type LeadFormState } from "@/lib/crm/lead-edit-form"

// Client component: imports ONLY prisma-free modules (same rule as
// LeadSlideOver, which owns this form's state and save path).

export const STATUS_LABELS: Record<string, string> = {
  NEW: "New", CONTACTED: "Contacted", QUALIFIED: "Qualified",
  PROPOSAL_SENT: "Proposal Sent", CONVERTED: "Converted", LOST: "Lost",
}

const inputCls =
  "w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm text-gray-900 outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 disabled:bg-gray-50 disabled:text-gray-500"

function sourceLabel(source: string): string {
  const m: Record<string, string> = { MANUAL: "Manual", WEBSITE: "Website", REFERRAL: "Referral", WALK_IN: "Walk-in", SOCIAL: "Social", WHATSAPP: "WhatsApp" }
  return m[source] ?? source
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-gray-500">{label}</label>
      {children}
    </div>
  )
}

export function LeadEditForm({
  lead,
  staff,
  form,
  initial,
  canEdit,
  onChange,
}: {
  lead: { status: string; source: string }
  staff: AssignableStaff[]
  form: LeadFormState
  /** The SAVED record as a form snapshot — hide-empty keys off this, never the
   *  live draft, so a field being cleared mid-edit can't vanish under the cursor. */
  initial: LeadFormState
  canEdit: boolean
  onChange: <K extends keyof LeadFormState>(k: K, v: LeadFormState[K]) => void
}) {
  const owner = resolveLeadOwner(form.assignedToId || null, staff)
  // GHL's "Hide empty fields" — collapses OPTIONAL fields blank ON THE RECORD
  // (email / requested amount / notes). Core identity + stage always show.
  // Deliberately not persisted: the toggle resets when the tab unmounts.
  const [hideEmpty, setHideEmpty] = useState(false)
  const show = (saved: string) => !hideEmpty || saved.trim() !== ""

  return (
    <>
      {/* Own row, not part of a section header — the toggle governs the WHOLE
          form (both sections + notes). */}
      <div className="flex justify-end">
        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-500">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} className="h-3.5 w-3.5 accent-amber-600" />
          Hide empty fields
        </label>
      </div>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Contact details</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="First name">
          <input className={inputCls} value={form.firstName} disabled={!canEdit} onChange={(e) => onChange("firstName", e.target.value)} />
        </FormField>
        <FormField label="Last name">
          <input className={inputCls} value={form.lastName} disabled={!canEdit} onChange={(e) => onChange("lastName", e.target.value)} />
        </FormField>
        <FormField label="Phone">
          <input className={inputCls} value={form.phone} disabled={!canEdit} onChange={(e) => onChange("phone", e.target.value)} />
        </FormField>
        {show(initial.email) && (
          <FormField label="Email">
            <input className={inputCls} value={form.email} disabled={!canEdit} onChange={(e) => onChange("email", e.target.value)} />
          </FormField>
        )}
      </div>

      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Lead details</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField label="Stage">
          {lead.status === "CONVERTED" || lead.status === "LOST" ? (
            <input className={inputCls} value={STATUS_LABELS[lead.status]} disabled readOnly />
          ) : (
            <select className={inputCls} value={form.status} disabled={!canEdit} onChange={(e) => onChange("status", e.target.value)}>
              {EDITABLE_STAGES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          )}
        </FormField>
        <FormField label="Owner">
          <select className={inputCls} value={form.assignedToId} disabled={!canEdit} onChange={(e) => onChange("assignedToId", e.target.value)}>
            <option value="">Unassigned</option>
            {staff.map((s) => <option key={s.id} value={s.id}>{s.name ?? s.email}</option>)}
            {/* A dangling owner has no staff row to select; keep it addressable
                so the control shows the real stored value instead of snapping
                to "Unassigned" and inviting a silent overwrite — same rule as
                LeadOwnerSelect on the full page. */}
            {owner.state === "unknown" && <option value={form.assignedToId}>{owner.label}</option>}
          </select>
        </FormField>
        <FormField label="Source">
          <div className="flex h-9 items-center text-sm text-gray-500">{sourceLabel(lead.source)}</div>
        </FormField>
        {/* Hideable field LAST in the grid so hiding it never re-packs the
            columns of the always-visible fields above. */}
        {show(initial.requestedRand) && (
          <FormField label="Requested amount (R)">
            <input className={inputCls} inputMode="numeric" value={form.requestedRand} disabled={!canEdit} onChange={(e) => onChange("requestedRand", e.target.value)} placeholder="—" />
          </FormField>
        )}
      </div>

      {show(initial.notes) && (
        <FormField label="Notes">
          <textarea className={`${inputCls} h-24 resize-y`} value={form.notes} disabled={!canEdit} onChange={(e) => onChange("notes", e.target.value)} />
        </FormField>
      )}

      {(lead.status === "CONVERTED" || lead.status === "LOST") && (
        <p className="text-xs text-gray-500">
          This lead is {STATUS_LABELS[lead.status].toLowerCase()}. To change that, open the full page.
        </p>
      )}
      {!canEdit && <p className="text-xs text-gray-500">You have view-only access to this lead.</p>}
    </>
  )
}
