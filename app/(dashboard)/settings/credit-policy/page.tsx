import { requireMinRole } from "@/lib/auth-guards"
import { CreditPolicyForm } from "@/components/settings/CreditPolicyForm"
import { Header } from "@/components/layout/Header"

export const metadata = {
  title: "Credit Policy — Settings",
}

export default async function CreditPolicySettingsPage() {
  await requireMinRole("ADMIN")

  return (
    <>
      <Header
        title="Credit Policy"
        subtitle="Configure the Experian bureau score gate and affordability buffer applied when deciding applications."
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Credit Policy" },
        ]}
      />
      <div className="p-4 lg:p-8 max-w-4xl space-y-6">
        <CreditPolicyForm />
      </div>
    </>
  )
}
