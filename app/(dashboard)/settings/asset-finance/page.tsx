import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { Header } from "@/components/layout/Header"
import { AssetFinanceModuleSettings } from "@/components/settings/AssetFinanceModuleSettings"
import { VatConfigForm } from "@/components/settings/VatConfigForm"

// Deliberately NOT under app/(dashboard)/asset-finance/layout.tsx: that layout
// redirects while featureAssetFinance is off, and this page turns it on.

export const metadata = {
  title: "Asset Finance — Settings",
}

// Schema defaults (prisma/schema.prisma model TenantConfig), for a tenant with no config row.
const DEFAULTS = { featureAssetFinance: false, assetPayoutDualApprovalCents: 100_000_000, assetFinanceLegalWordingApproved: false }

export default async function AssetFinanceSettingsPage() {
  // A tenant-wide switch is ADMIN (manage_settings), as the API requires.
  const { tenantId } = await requireMinRole("ADMIN")
  const [config, vat] = await Promise.all([
    prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { featureAssetFinance: true, assetPayoutDualApprovalCents: true, assetFinanceLegalWordingApproved: true },
    }),
    prisma.vatConfig.findUnique({ where: { tenantId }, select: { vatNumber: true, registeredName: true, address: true } }),
  ])
  const settings = config ?? DEFAULTS

  return (
    <>
      <Header
        title="Asset Finance"
        subtitle="Switch the module on or off, set the payout approval threshold and the VAT vendor details."
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Asset Finance" }]}
      />
      <div className="max-w-4xl space-y-6 p-4 lg:p-8">
        <AssetFinanceModuleSettings {...settings} />
        <VatConfigForm initial={vat} moduleEnabled={settings.featureAssetFinance} />
      </div>
    </>
  )
}
