import { notFound } from "next/navigation"
import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DsarClient } from "@/components/compliance/DsarClient"
import { getResolvedTenantId } from "@/lib/tenant"

export default async function DsarPage() {
  const user = await requireMinRole("ADMIN")
  const tenantId = await getResolvedTenantId()
  // withTenantContext's binding, for a page: a session never reads another
  // tenant's rows because the host resolved to it.
  if (user.tenantId !== tenantId) notFound()
  const [dsars, clients] = await Promise.all([
    prisma.dataSubjectRequest.findMany({
      where: { tenantId },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true, idNumber: true, email: true },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.client.findMany({
      where: { tenantId },
      select: { id: true, firstName: true, lastName: true, idNumber: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    }),
  ])

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Compliance", href: "/compliance" },
          { label: "DSAR" },
        ]}
      />
      <DsarClient dsars={dsars} clients={clients} />
    </div>
  )
}
