import { requireMinRole } from "@/lib/auth-guards"
import { LenderIdentityForm } from "@/components/settings/LenderIdentityForm"
import { LenderLogoUpload } from "@/components/settings/LenderLogoUpload"
import { Header } from "@/components/layout/Header"

export const metadata = {
  title: "Lender Identity — Settings",
}

export default async function LenderIdentitySettingsPage() {
  await requireMinRole("ADMIN")

  return (
    <>
      <Header
        title="Lender Identity"
        subtitle="Legal name, registration numbers, registered office and contact details printed on NCA documents and customer messages. Documents are refused until this is complete."
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Lender Identity" },
        ]}
      />
      <div className="p-4 lg:p-8 max-w-4xl space-y-6">
        <LenderIdentityForm />
        <LenderLogoUpload />
      </div>
    </>
  )
}
