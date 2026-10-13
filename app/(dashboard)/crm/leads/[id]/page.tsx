import { canWriteLeadActivity } from "@/lib/crm/lead-write-access"
import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { LeadDetailClient } from "@/components/crm/LeadDetailClient"
import { auth } from "@/lib/auth"
import type { AppRole } from "@/lib/auth"
import { hasMinRole } from "@/lib/auth-guards"
import { getDefaultTenantId } from "@/lib/tenant"
import { listCannedReplies } from "@/lib/inbox/canned-replies"
import { getContactComms } from "@/lib/inbox/contact-comms"
import { listAssignableStaff, findAssignableStaff } from "@/lib/crm/staff"
import { agentDisplayName } from "@/lib/crm/lead-outreach-templates"
import { calculateLeadScore } from "@/lib/lead-scoring"
import { OPEN_TASK_STATUSES, LEAD_ENTITY_TYPE } from "@/lib/crm/lead-tasks"
import { findLeadDuplicatesForTenant } from "@/lib/crm/lead-dedup-search"

async function getLead(id: string, tenantId: string) {
  return prisma.lead.findFirst({
    where: { id, tenantId },
    include: {
      activities: { orderBy: { createdAt: "desc" } },
      _count: { select: { activities: true } },
      contact: { select: { id: true } },
    },
  })
}

/**
 * Open tasks for this lead, soonest-due first.
 *
 * `AgentTask` is not in TENANT_SCOPED_MODELS, so the tenantId filter is manual
 * — and (entityType, entityId) is a bare polymorphic pair with no FK, so both
 * halves are needed or a Client id could match a Lead id.
 */
async function getLeadTasks(leadId: string, tenantId: string) {
  return prisma.agentTask.findMany({
    where: {
      tenantId,
      entityType: LEAD_ENTITY_TYPE,
      entityId: leadId,
      status: { in: [...OPEN_TASK_STATUSES] },
    },
    include: { assignee: { select: { id: true, name: true, email: true } } },
    // Nulls last: an undated task has no urgency to sort on.
    orderBy: [{ dueAt: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
    take: 50,
  })
}

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const tenantId = await getDefaultTenantId()
  const session = await auth()
  const role = session?.user?.role as AppRole | undefined
  // reassignLead gates on CREDIT_OFFICER, so anyone below it would get a
  // picker that only bounces them — and the whole staff directory serialised
  // into the RSC payload to render it. Below the bar we fetch just the current
  // owner, which is all the read-only label needs.
  const canReassign = role !== undefined && hasMinRole(role, "CREDIT_OFFICER")
  // Two DIFFERENT task permissions, each derived from its own bar rather than
  // from canReassign or from each other. They all sit at CREDIT_OFFICER today;
  // reusing one for another is how moving a single bar silently moves three.
  //
  //   canCreateTasks  — mirrors POST /api/agent-tasks.
  //   canManageTasks  — mirrors PATCH's `canManage`: may act on ANY task.
  //
  // Completing is NOT decided here at all: it is per-row (your own task is
  // yours to close), so the panel takes the session id and works it out per
  // task. The assignee picker is populated from `staff` — any active staff may
  // be assigned a task, deliberately: lead follow-up is mostly credit work but
  // not exclusively, and a role floor would make the exception impossible.
  const canCreateTasks = role !== undefined && hasMinRole(role, "CREDIT_OFFICER")
  const canManageTasks = role !== undefined && hasMinRole(role, "CREDIT_OFFICER")
  // Stage change / add activity / notes / pin: the actions gate on CREDIT_OFFICER,
  // so below it the controls are not rendered (read-only lead).
  const canWriteActivity = canWriteLeadActivity(role)

  const [lead, cannedReplies, tasks, dupes] = await Promise.all([
    getLead(id, tenantId),
    listCannedReplies(tenantId),
    getLeadTasks(id, tenantId),
    // Only the count crosses to the client — the duplicate rows themselves are
    // other people's contact details and belong on the review page, which is
    // where a human actually looks at them.
    findLeadDuplicatesForTenant(id, tenantId),
  ])

  if (!lead) notFound()

  const staff = canReassign
    ? await listAssignableStaff(tenantId)
    : lead.assignedToId
      ? [await findAssignableStaff(tenantId, lead.assignedToId)].filter((s) => s !== null)
      : []

  // Score computed on read (see leads/page.tsx) so the tier badge reflects the
  // live value rather than the never-populated persisted column.
  const scoredLead = { ...lead, leadScore: calculateLeadScore(lead) }

  // Older leads may not have a Contact yet (directory backfill reconciles
  // them) — the page renders without messaging until one exists.
  const comms = lead.contact
    ? await getContactComms({ tenantId, contactId: lead.contact.id })
    : null

  const cannedRepliesSafe = cannedReplies.map((c) => ({ id: c.id, title: c.title, body: c.body }))

  // Dates → ISO strings at the server/client boundary, matching the panel's
  // props contract (and what an eventual JSON fetch of the same rows returns).
  const tasksSafe = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    priority: t.priority,
    status: t.status,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    assignee: t.assignee,
  }))

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-6"
        items={[
          { label: "CRM", href: "/crm" },
          { label: "Leads", href: "/crm/leads" },
          { label: `${lead.firstName} ${lead.lastName}` },
        ]}
      />
      <LeadDetailClient
        lead={scoredLead}
        hasContact={!!lead.contact}
        cannedReplies={cannedRepliesSafe}
        commsMessages={comms?.messages ?? []}
        staff={staff}
        canReassign={canReassign}
        tasks={tasksSafe}
        canCreateTasks={canCreateTasks}
        canManageTasks={canManageTasks}
        canWriteActivity={canWriteActivity}
        currentUserId={session?.user?.id ?? ""}
        duplicateCount={dupes.duplicates.length}
        duplicatesTruncated={dupes.truncated}
        // Same helper the send path uses, so the previewed signature is the
        // one that actually goes out.
        agentName={agentDisplayName(session?.user?.name)}
      />
    </div>
  )
}
