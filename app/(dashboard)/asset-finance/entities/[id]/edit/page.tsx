import { notFound, redirect } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { EntityForm } from "@/components/asset-finance/EntityForm"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { loadEntityCore } from "@/lib/asset-finance/entity-detail"

export default async function EditEntityPage({ params }: { params: Promise<{ id: string }> }) {
  const { tenantId, canManage } = await requireAssetFinanceStaffPage()
  const { id } = await params
  if (!canManage) redirect(`/asset-finance/entities/${id}`)
  const entity = await loadEntityCore(tenantId, id)
  if (!entity) notFound()
  return (
    <>
      <Header
        title={`Edit ${entity.legalName}`}
        subtitle="Changing turnover, asset value or the financial year clears the attached financials evidence"
        breadcrumbs={[
          { label: "Asset Finance" },
          { label: "Entities", href: "/asset-finance/entities" },
          { label: entity.legalName, href: `/asset-finance/entities/${id}` },
          { label: "Edit" },
        ]}
      />
      <div className="p-4 lg:p-8">
        <EntityForm
          entityId={id}
          initial={{
            type: entity.type,
            legalName: entity.legalName,
            tradingName: entity.tradingName ?? "",
            registrationNumber: entity.registrationNumber,
            vatNumber: entity.vatNumber ?? "",
            annualTurnover: entity.annualTurnover,
            totalAssetValue: entity.totalAssetValue,
            financialYearEnd: entity.financialYearEnd ?? "",
            addressLine1: entity.addressLine1 ?? "",
            addressLine2: entity.addressLine2 ?? "",
            city: entity.city ?? "",
            province: entity.province ?? "",
            postalCode: entity.postalCode ?? "",
          }}
        />
      </div>
    </>
  )
}
