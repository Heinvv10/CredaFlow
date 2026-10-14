import { LoanProductForm } from "@/components/products/LoanProductForm"
import { requireMinRole } from "@/lib/auth-guards"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"

export default async function NewLoanProductPage() {
  // Product create is an ADMIN mutation — gate the form page to match.
  const { tenantId } = await requireMinRole("ADMIN")
  const assetFinance = resolveFeatureFlags(await getTenantConfig(tenantId)).featureAssetFinance
  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Settings", href: "/settings" },
          { label: "Products", href: "/settings/products" },
          { label: "Loan products", href: "/settings/products/loan" },
          { label: "New loan product" },
        ]}
      />
      <LoanProductForm nonNcaArrears={assetFinance ? { marginPercent: "", feeRand: "" } : undefined} />
    </div>
  )
}
