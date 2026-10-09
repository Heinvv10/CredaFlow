import { prisma } from "@/lib/prisma"
import { requireMinRole } from "@/lib/auth-guards"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { ComplaintsClient } from "@/components/compliance/ComplaintsClient"
import { getDefaultTenantId } from "@/lib/tenant"

export default async function ComplaintsPage() {
  await requireMinRole("LOAN_ADMIN")
  const tenantId = await getDefaultTenantId()
  const [complaints, clients] = await Promise.all([
    prisma.complaint.findMany({
      where: { tenantId },
      include: {
        client: {
          select: { id: true, firstName: true, lastName: true, idNumber: true, phone: true, email: true },
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
          { label: "Complaints" },
        ]}
      />
      <ComplaintsClient complaints={complaints} clients={clients} />
    </div>
  )
}
