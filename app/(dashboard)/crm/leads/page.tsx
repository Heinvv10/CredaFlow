import { prisma } from "@/lib/prisma"
import { LeadKanban } from "@/components/crm/LeadKanban"
import { getDefaultTenantId } from "@/lib/tenant"
import { calculateLeadScore } from "@/lib/lead-scoring"
import { countDuplicatesByPhone } from "@/lib/crm/lead-dedup"

async function getLeads(tenantId: string) {
  return prisma.lead.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { activities: true } },
    },
  })
}

export default async function LeadsPage() {
  const tenantId = await getDefaultTenantId()
  const leads = await getLeads(tenantId)

  // Score is computed on read rather than persisted: it depends on lead age
  // (freshness), so a stored value would go stale, and there is no scoring
  // cron. The pure calculator is cheap for a pipeline's worth of leads.
  //
  // Duplicate counts likewise, and in ONE pass over the rows already fetched
  // above — `leads` is the whole tenant, which is what countDuplicatesByPhone
  // needs to count correctly. Calling the per-lead search instead would run a
  // 5000-row scan for every card on the board.
  const duplicates = countDuplicatesByPhone(leads)
  const scored = leads.map((lead) => ({
    ...lead,
    leadScore: calculateLeadScore(lead),
    duplicateCount: duplicates.get(lead.id) ?? 0,
  }))

  return (
    <div className="p-6 lg:p-8">
      <LeadKanban initialLeads={scored} />
    </div>
  )
}
