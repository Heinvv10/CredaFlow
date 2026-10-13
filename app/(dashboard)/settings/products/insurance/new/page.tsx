import { prisma } from "@/lib/prisma"
import { InsuranceProductForm } from "@/components/products/InsuranceProductForm"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"

export default async function NewInsuranceProductPage() {
  // Product create is an ADMIN mutation — gate the form page to match.
  await requireMinRole("ADMIN")
  const tenantId = await getStaffTenantId()
  const insurers = await prisma.insurer.findMany({
    where: { tenantId, active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  })
  return (
    <div className="p-6 lg:p-8">
      <Breadcrumbs
        className="mb-4"
        items={[
          { label: "Settings", href: "/settings" },
          { label: "Products", href: "/settings/products" },
          { label: "Insurance products", href: "/settings/products/insurance" },
          { label: "New insurance product" },
        ]}
      />
      <InsuranceProductForm insurers={insurers} />
    </div>
  )
}
