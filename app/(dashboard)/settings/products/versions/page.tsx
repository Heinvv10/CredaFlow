import { redirect } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { ProductVersionsWorkspace } from "@/components/settings/product-versions/ProductVersionsWorkspace"
import type { EngineOverview } from "@/components/settings/product-versions/types"
import { requireMinRole } from "@/lib/auth-guards"
import { canDo } from "@/lib/permissions"
import { loadProductEngineOverview } from "@/lib/product-engine/overview"
import { getStaffTenantId } from "@/lib/session-tenant"

export const metadata = {
  title: "Product versions — Settings",
}

export default async function ProductVersionsPage() {
  const user = await requireMinRole("LOAN_ADMIN")
  if (!canDo(user.role, "view_product_versions")) redirect("/settings")
  const overview = await loadProductEngineOverview(await getStaffTenantId(), user)
  // The overview is plain JSON (dates are strings), safe to hand to the client.
  const props = { ...overview, canManage: canDo(user.role, "manage_product_versions"), canApprove: canDo(user.role, "approve_product_versions") } as unknown as EngineOverview

  return (
    <>
      <Header
        title="Product versions and pricing"
        subtitle="Versions of each lending product with effective dates, repayment structures and pricing rules by segment, risk grade and channel. Every change needs a second person's approval."
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Products", href: "/settings/products" }, { label: "Versions and pricing" }]}
      />
      <div className="p-4 lg:p-8 max-w-6xl space-y-6">
        <ProductVersionsWorkspace overview={props} />
      </div>
    </>
  )
}
