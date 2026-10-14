import { notFound, redirect } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { AddPersonClient } from "@/components/asset-finance/AddPersonClient"
import { prisma } from "@/lib/prisma"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"

export default async function AddPersonPage({ params }: { params: Promise<{ id: string }> }) {
  const { tenantId, canManage } = await requireAssetFinanceStaffPage()
  const { id } = await params
  if (!canManage) redirect(`/asset-finance/entities/${id}`)
  const entity = await prisma.businessEntity.findFirst({
    where: { id, tenantId },
    select: { id: true, type: true, legalName: true },
  })
  if (!entity) notFound()
  const clients = await prisma.client.findMany({
    where: { tenantId, deceasedAt: null },
    orderBy: { lastName: "asc" },
    select: { id: true, firstName: true, lastName: true, email: true },
  })

  return (
    <>
      <Header
        title={`Add a person to ${entity.legalName}`}
        subtitle="Link an existing client or create a new one"
        breadcrumbs={[
          { label: "Asset Finance" },
          { label: "Entities", href: "/asset-finance/entities" },
          { label: entity.legalName, href: `/asset-finance/entities/${id}` },
          { label: "Add person" },
        ]}
      />
      <div className="p-4 lg:p-8">
        <AddPersonClient entityId={entity.id} entityType={entity.type} clients={clients} />
      </div>
    </>
  )
}
