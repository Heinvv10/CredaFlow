import { prisma } from "@/lib/prisma"
import { notFound } from "next/navigation"
import { LoanProductForm } from "@/components/products/LoanProductForm"
import { nonNcaArrearsValues } from "@/lib/product-config/non-nca-arrears-form"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { requireMinRole } from "@/lib/auth-guards"

export default async function EditLoanProductPage({ params }: { params: Promise<{ id: string }> }) {
  // Product edit is an ADMIN mutation — gate the form page to match.
  // The session's tenant: the one the save (withTenantContext) is bound to.
  const { tenantId } = await requireMinRole("ADMIN")
  const { id } = await params
  const [product, config] = await Promise.all([
    prisma.loanProduct.findUnique({ where: { id, tenantId } }),
    getTenantConfig(tenantId),
  ])
  if (!product) notFound()
  const nonNcaArrears = resolveFeatureFlags(config).featureAssetFinance
    ? nonNcaArrearsValues(product.nonNcaDefaultInterestMargin?.toString() ?? null, product.nonNcaCollectionFeeCents)
    : undefined

  const initial = {
    id: product.id,
    code: product.code,
    name: product.name,
    productType: product.productType,
    minAmount: product.minAmount / 100,
    maxAmount: product.maxAmount / 100,
    minTermDays: product.minTermDays,
    maxTermDays: product.maxTermDays,
    interestRatePm: product.interestRatePm * 100,
    interestModel: product.interestModel,
    initiationFeePct: product.initiationFeePct * 100,
    initiationFeeModel: product.initiationFeeModel,
    initiationFeeMax: product.initiationFeeMax / 100,
    monthlyServiceFee: product.monthlyServiceFee / 100,
    active: product.active,
  }

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Settings", href: "/settings" },
          { label: "Products", href: "/settings/products" },
          { label: "Loan products", href: "/settings/products/loan" },
          { label: product.name },
        ]}
      />
      <LoanProductForm initial={initial} nonNcaArrears={nonNcaArrears} />
    </div>
  )
}
