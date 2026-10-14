import { redirect } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { EMPTY_ENTITY_FORM, EntityForm } from "@/components/asset-finance/EntityForm"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"

export default async function NewEntityPage() {
  const { canManage } = await requireAssetFinanceStaffPage()
  if (!canManage) redirect("/asset-finance/entities")
  return (
    <>
      <Header
        title="New business entity"
        subtitle="A company, close corporation, trust or partnership"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Entities", href: "/asset-finance/entities" }, { label: "New" }]}
      />
      <div className="p-4 lg:p-8">
        <EntityForm initial={EMPTY_ENTITY_FORM} />
      </div>
    </>
  )
}
