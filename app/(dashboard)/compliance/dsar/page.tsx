import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DsarClient } from "@/components/compliance/DsarClient"
import { getDefaultTenantId } from "@/lib/tenant"

export default async function DsarPage() {
  await requireMinRole("ADMIN")
  const tenantId = await getDefaultTenantId()
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
