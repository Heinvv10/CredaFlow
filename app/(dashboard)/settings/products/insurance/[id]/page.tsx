import Link from "next/link"
import { prisma } from "@/lib/prisma"
import { notFound } from "next/navigation"
import { InsuranceProductForm } from "@/components/products/InsuranceProductForm"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { getStaffTenantId } from "@/lib/session-tenant"
import { requireMinRole } from "@/lib/auth-guards"

export default async function EditInsuranceProductPage({ params }: { params: Promise<{ id: string }> }) {
  // Product edit is an ADMIN mutation — gate the form page to match.
  await requireMinRole("ADMIN")
  const { id } = await params
  const tenantId = await getStaffTenantId()
  const product = await prisma.insuranceProduct.findUnique({ where: { id, tenantId } })
  if (!product) notFound()

  const insurers = await prisma.insurer.findMany({
    where: { tenantId, active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })

  const initial = {
    id: product.id,
    code: product.code,
    name: product.name,
    type: product.type,
    premiumAmount: Number(product.premiumAmount),
    sumAssured: Number(product.sumAssured),
    commissionRate: Number(product.commissionRate),
    active: product.active,
    insurerId: product.insurerId,
  }

  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Settings", href: "/settings" },
          { label: "Products", href: "/settings/products" },
          { label: "Insurance products", href: "/settings/products/insurance" },
          { label: product.name },
        ]}
      />
      {/*
        Rating and eligibility live on their own screens because they are
        versioned, insurer-supplied configuration rather than product fields.
        Only the two types the rate-table system prices are linked: credit life
        and the short-term types are priced elsewhere and have no rate card.
      */}
      {RATED_TYPES.includes(product.type) && (
        <div className="mb-6 flex flex-wrap gap-3">
          <Link
            href={`/settings/products/insurance/${product.id}/rates`}
            className="px-4 py-2 border border-gray-200 hover:border-[#4F46E5] text-sm font-semibold rounded-lg"
          >
            Rate card →
          </Link>
          <Link
            href={`/settings/products/insurance/${product.id}/eligibility`}
            className="px-4 py-2 border border-gray-200 hover:border-[#4F46E5] text-sm font-semibold rounded-lg"
          >
            Eligibility rules →
          </Link>
        </div>
      )}

      <InsuranceProductForm initial={initial} insurers={insurers} />
    </div>
  )
}

/** The product types priced from an InsuranceRateTable. */
const RATED_TYPES: string[] = ["FUNERAL_COVER", "LIFE_INSURANCE"]
