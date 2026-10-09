import { prisma } from "@/lib/prisma"
import { getContactComms } from "@/lib/inbox/contact-comms"
import { listCannedReplies } from "@/lib/inbox/canned-replies"
import { listAssignableStaff, findAssignableStaff } from "@/lib/crm/staff"
import { calculateLeadScore } from "@/lib/lead-scoring"
import { OPEN_TASK_STATUSES, LEAD_ENTITY_TYPE } from "@/lib/crm/lead-tasks"
import { findLeadDuplicatesForTenant } from "@/lib/crm/lead-dedup-search"
import type { AssignableStaff } from "@/lib/crm/lead-assignment"
import type { LeadTask } from "@/components/crm/LeadTasksPanel"
import type { TimelineMessageInput } from "@/lib/crm/lead-timeline"

// Server-only by construction (imports prisma). The one place that assembles
// "everything the lead record UI needs", so the full-page detail and the
// slide-over modal render from the SAME shape and cannot drift — a field the
// page shows but the modal's fetch omits would be an invisible gap that only
// surfaces when a staff member opens the modal.

/** Dates crossed to ISO strings at the server/client boundary — the shape a
 *  JSON fetch of these rows returns, which is what the modal actually gets. */
export type LeadDetailBundle = {
  lead: {
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
    leadScore: number
    callbackDate: string | null
    callbackNotes: string | null
    lostReason: string | null
    convertedToClientId: string | null
    convertedToApplicationId: string | null
    conversionRecoveryRequired: boolean
    createdAt: string
  }
  activities: {
    id: string
    type: string
    subject: string
    notes: string | null
    pinned: boolean
    createdAt: string
  }[]
  commsMessages: TimelineMessageInput[]
  tasks: LeadTask[]
  /** Assignable staff — only the current owner when the viewer can't reassign,
   *  to avoid serialising the whole directory into a picker they can't use. */
  staff: AssignableStaff[]
  hasContact: boolean
  /** Canned replies for the compose drawer (Outreach tab) — mapped to the
   *  same {id,title,body} shape the detail page passes, nothing extra. */
  cannedReplies: { id: string; title: string; body: string }[]
  /** Leads sharing this one's phone or email (see lib/crm/lead-dedup). */
  duplicateCount: number
  /** The dedup scan hit its cap — a 0 count then means "unknown", not "none".
   *  Carried so the modal's flag can't read a capped scan as an all-clear, the
   *  same guard the full page makes. */
  duplicatesTruncated: boolean
}

async function getLeadForBundle(id: string, tenantId: string) {
  // Manual tenantId filter: Lead is absent from TENANT_SCOPED_MODELS.
  return prisma.lead.findFirst({
    where: { id, tenantId },
    include: {
      activities: { orderBy: { createdAt: "desc" } },
      contact: { select: { id: true } },
    },
  })
}

async function getLeadTasks(leadId: string, tenantId: string) {
  // (entityType, entityId) is a bare polymorphic pair with no FK — both halves
  // are needed or a Client id could match a Lead id. tenantId manual as above.
  return prisma.agentTask.findMany({
    where: {
      tenantId,
      entityType: LEAD_ENTITY_TYPE,
      entityId: leadId,
      status: { in: [...OPEN_TASK_STATUSES] },
    },
    include: { assignee: { select: { id: true, name: true, email: true } } },
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: 50,
  })
}

/**
 * Everything the lead record UI needs for `leadId` within `tenantId`, or null
 * if the lead isn't in this tenant.
 *
 * `canReassign` decides whether the full staff directory is loaded (for the
 * owner picker) or just the current owner — the same trade the detail page
 * makes, kept here so both call sites make it identically.
 */
export async function getLeadDetailBundle(
  leadId: string,
  tenantId: string,
  canReassign: boolean
): Promise<LeadDetailBundle | null> {
  const lead = await getLeadForBundle(leadId, tenantId)
  if (!lead) return null

  const [tasks, dupes, cannedReplies, staff, comms] = await Promise.all([
    getLeadTasks(leadId, tenantId),
    findLeadDuplicatesForTenant(leadId, tenantId),
    listCannedReplies(tenantId),
    canReassign
      ? listAssignableStaff(tenantId)
      : lead.assignedToId
        ? findAssignableStaff(tenantId, lead.assignedToId).then((s) => (s ? [s] : []))
        : Promise.resolve([]),
    lead.contact
      ? getContactComms({ tenantId, contactId: lead.contact.id })
      : Promise.resolve(null),
  ])

  return {
    lead: {
      id: lead.id,
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      source: lead.source,
      status: lead.status,
      notes: lead.notes,
      assignedToId: lead.assignedToId,
      requestedAmount: lead.requestedAmount,
      // Score computed on read (see leads/page.tsx) — the persisted column is
      // never populated, so reading it would show a stale/null tier.
      leadScore: calculateLeadScore(lead),
      callbackDate: lead.callbackDate ? lead.callbackDate.toISOString() : null,
      callbackNotes: lead.callbackNotes,
      lostReason: lead.lostReason,
      convertedToClientId: lead.convertedToClientId,
      convertedToApplicationId: lead.convertedToApplicationId,
      conversionRecoveryRequired: lead.conversionRecoveryRequired,
      createdAt: lead.createdAt.toISOString(),
    },
    activities: lead.activities.map((a) => ({
      id: a.id,
      type: a.type,
      subject: a.subject,
      notes: a.notes,
      pinned: a.pinned,
      createdAt: a.createdAt.toISOString(),
    })),
    commsMessages: comms?.messages ?? [],
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      status: t.status,
      dueAt: t.dueAt ? t.dueAt.toISOString() : null,
      assignee: t.assignee,
    })),
    staff,
    hasContact: !!lead.contact,
    cannedReplies: cannedReplies.map((c) => ({ id: c.id, title: c.title, body: c.body })),
    duplicateCount: dupes.duplicates.length,
    duplicatesTruncated: dupes.truncated,
  }
}
