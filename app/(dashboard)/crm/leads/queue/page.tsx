import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"
import { calculateLeadScore, leadQueuePriority } from "@/lib/lead-scoring"
import { LeadWorkQueue, INSURANCE_ENQUIRY_TAG } from "@/components/crm/LeadWorkQueue"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"

// Only leads still in play belong in the "who to call next" queue — converted
// and lost leads are done.
const OPEN_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL_SENT"] as const

export default async function LeadQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>
}) {
  const { filter } = await searchParams
  const insuranceOnly = filter === "insurance"

  const tenantId = await getDefaultTenantId()
  const leads = await prisma.lead.findMany({
    where: {
      tenantId,
      status: { in: [...OPEN_STATUSES] },
      // `has` is an exact array-element match, not a substring test — a lead
      // tagged "insurance-enquiry-draft" would not qualify.
      ...(insuranceOnly ? { tags: { has: INSURANCE_ENQUIRY_TAG } } : {}),
    },
    include: { _count: { select: { activities: true } } },
  })

  // Sizes the "Insurance only" affordance on the unfiltered view. No branch
  // needed: when the filter IS active every row carries the tag, so this equals
  // leads.length anyway.
  const insuranceCount = leads.filter((l) => l.tags.includes(INSURANCE_ENQUIRY_TAG)).length

  const rows = leads
    .map((lead) => {
      const score = calculateLeadScore(lead)
      // now defaults inside leadQueuePriority (keeps Date.now() out of the
      // component body); per-lead microsecond drift is irrelevant to ordering.
      return { lead, score, priority: leadQueuePriority(score, lead.updatedAt) }
    })
    // Deterministic order: priority desc, then oldest-created first, then id —
    // so equal-priority leads (common for fresh NEW leads) keep a stable rank
    // across requests instead of reshuffling with Postgres's row order.
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.lead.createdAt.getTime() - b.lead.createdAt.getTime() ||
        a.lead.id.localeCompare(b.lead.id),
    )
    .map(({ lead, score }) => ({
      id: lead.id,
      firstName: lead.firstName,
      lastName: lead.lastName,
      phone: lead.phone,
      source: lead.source,
      status: lead.status,
      score,
      updatedAt: lead.updatedAt,
      activityCount: lead._count.activities,
      tags: lead.tags,
    }))

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-6"
        items={[
          { label: "CRM", href: "/crm" },
          { label: "Leads", href: "/crm/leads" },
          { label: insuranceOnly ? "Insurance enquiries" : "Work queue" },
        ]}
      />
      <LeadWorkQueue leads={rows} insuranceOnly={insuranceOnly} insuranceCount={insuranceCount} />
    </div>
  )
}
