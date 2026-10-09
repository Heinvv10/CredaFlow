"use client"

import { getScoreTier } from "@/lib/lead-scoring"
import { resolveLeadOwner, type AssignableStaff } from "@/lib/crm/lead-assignment"
import { STATUS_LABELS } from "@/components/crm/LeadEditForm"
import type { LeadFormState } from "@/lib/crm/lead-edit-form"
import { formatZARCompact, SAST_TIME_ZONE } from "@/lib/utils"

// Client component: prisma-free imports only. Attio/Pipedrive-style
// always-visible highlights band under the modal header — the key context
// stays on screen while the user moves between tabs.

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">{label}</span>
      <span className="text-xs text-gray-800">{children}</span>
    </span>
  )
}

export function LeadModalHighlights({
  lead,
  form,
  staff,
}: {
  lead: {
    status: string
    leadScore: number
    requestedAmount: number | null
    assignedToId: string | null
    callbackDate: string | null
  }
  /** The Details tab's live draft — stage/owner/amount prefer it so the band
   *  never contradicts the form being edited right below it. */
  form: LeadFormState | null
  staff: AssignableStaff[]
}) {
  const tier = getScoreTier(lead.leadScore)
  const status = form?.status ?? lead.status
  const owner = resolveLeadOwner(form ? form.assignedToId || null : lead.assignedToId, staff)
  // Number.isFinite, not `|| null`: a typed "0" is a real R0, not empty.
  const draftCents = Math.round(Number(form?.requestedRand) * 100)
  const requestedCents = form
    ? form.requestedRand.trim() === "" ? null : Number.isFinite(draftCents) ? draftCents : null
    : lead.requestedAmount

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-gray-200 bg-gray-50 px-6 py-2">
      <Item label="Score">
        <span className="rounded px-1.5 py-0.5 text-[11px] font-semibold" style={{ color: tier.color, background: tier.bg }}>
          {tier.label} {lead.leadScore}
        </span>
      </Item>
      <Item label="Stage">{STATUS_LABELS[status] ?? status}</Item>
      <Item label="Requested">{requestedCents !== null ? formatZARCompact(requestedCents) : "—"}</Item>
      <Item label="Owner">{owner.label}</Item>
      <Item label="Callback">
        {lead.callbackDate
          ? new Date(lead.callbackDate).toLocaleString("en-ZA", {
              timeZone: SAST_TIME_ZONE,
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "—"}
      </Item>
    </div>
  )
}
