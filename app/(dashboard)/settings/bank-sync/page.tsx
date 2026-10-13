import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { BankSyncToggle } from "@/components/settings/BankSyncToggle"
import { Header } from "@/components/layout/Header"

export const metadata = {
  title: "Bank Statement Import — Settings",
}

export default async function BankSyncSettingsPage() {
  // Tenant-wide feature switch: ADMIN, same as the insurance module screen.
  await requireMinRole("ADMIN")
  const tenantId = await getStaffTenantId()
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { bankSyncEnabled: true },
  })

  return (
    <>
      <Header
        title="Bank Statement Import"
        subtitle="Switch bank-statement CSV import and reconciliation on or off."
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Bank Statement Import" },
        ]}
      />
      <div className="p-4 lg:p-8 max-w-4xl space-y-6">
        <BankSyncToggle bankSyncEnabled={config?.bankSyncEnabled ?? false} />
      </div>
    </>
  )
}
