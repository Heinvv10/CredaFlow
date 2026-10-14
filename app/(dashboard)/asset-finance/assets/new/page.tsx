import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { AssetCreateForm } from "./AssetCreateForm"

export default async function NewAssetPage() {
  const { canManage } = await requireAssetFinanceStaffPage()
  if (!canManage) notFound()

  return (
    <>
      <Header
        title="Register an asset"
        subtitle="A serial number or VIN already financed and not released is refused"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Assets", href: "/asset-finance/assets" }, { label: "New" }]}
      />
      <div className="p-4 lg:p-8">
        <AssetCreateForm />
      </div>
    </>
  )
}
