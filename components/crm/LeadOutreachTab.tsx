"use client"

import { MessageClientButton } from "@/components/messaging/MessageClientButton"
import { LeadOutreachButtons } from "@/components/crm/LeadOutreachButtons"
import { leadOutreachEligibility } from "@/lib/crm/lead-outreach-eligibility"

// Client component: imports ONLY prisma-free modules (same rule as
// LeadSlideOver, which mounts this as the modal's Outreach tab). Both controls
// are the SAME components the full lead page mounts — the send paths, their
// server gates, and the eligibility rules stay single-sourced.

export function LeadOutreachTab({
  lead,
  hasContact,
  cannedReplies,
  agentName,
}: {
  lead: { id: string; firstName: string; lastName: string; status: string; requestedAmount: number | null }
  hasContact: boolean
  cannedReplies: { id: string; title: string; body: string }[]
  agentName: string
}) {
  // No contact ⇒ nothing to send to — same bar the full page applies. Unlike
  // the page (which just omits the cards), the tab says why it's empty.
  if (!hasContact) {
    return (
      <p className="py-8 text-center text-sm text-gray-500">
        No contact record is linked to this lead yet, so there is nothing to
        send to. The directory backfill links one automatically.
      </p>
    )
  }

  return (
    <div className="space-y-4">
      <LeadOutreachButtons
        leadId={lead.id}
        eligibility={leadOutreachEligibility(lead)}
        leadFirstName={lead.firstName}
        agentName={agentName}
      />
      <div className="rounded-lg border border-gray-100 bg-white p-4 shadow-sm">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-400">Compose</p>
        <MessageClientButton
          clientId={lead.id}
          clientName={`${lead.firstName} ${lead.lastName}`}
          cannedReplies={cannedReplies}
          apiBase={`/api/crm/leads/${lead.id}`}
          fullWidth
        />
      </div>
    </div>
  )
}
