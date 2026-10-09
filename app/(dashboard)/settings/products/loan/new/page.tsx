import { LoanProductForm } from "@/components/products/LoanProductForm"
import { requireMinRole } from "@/lib/auth-guards"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"

export default async function NewLoanProductPage() {
  // Product create is an ADMIN mutation — gate the form page to match (F-29).
  await requireMinRole("ADMIN")
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
      <LoanProductForm />
    </div>
  )
}
