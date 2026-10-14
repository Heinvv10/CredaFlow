import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { SupplierCreateForm } from "./SupplierCreateForm"

export default async function NewSupplierPage() {
  const { canManage } = await requireAssetFinanceStaffPage()
  if (!canManage) notFound()

  return (
    <>
      <Header
        title="New supplier"
        subtitle="Capture the bank account on the next page; a second user approves it"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Suppliers", href: "/asset-finance/suppliers" }, { label: "New" }]}
      />
      <div className="p-4 lg:p-8">
        <SupplierCreateForm />
      </div>
    </>
  )
}
