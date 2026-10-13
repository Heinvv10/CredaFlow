import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { OpportunitiesClient } from "@/components/crm/OpportunitiesClient"

async function getOpportunities() {
  // Pages run outside a tenant frame: the filter is the boundary, and the
  // tenant-scope extension throws without it.
  const tenantId = await getStaffTenantId()
  return prisma.crossSellOpportunity.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
    include: {
      client: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          phone: true,
          loans: {
            select: { principal: true, status: true },
          },
        },
      },
    },
  })
}

export default async function OpportunitiesPage() {
  const opportunities = await getOpportunities()

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "CRM", href: "/crm" },
          { label: "Opportunities" },
        ]}
      />
      <OpportunitiesClient opportunities={opportunities} />
    </div>
  )
}
