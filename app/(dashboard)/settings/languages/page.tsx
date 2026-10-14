import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { prisma } from "@/lib/prisma"
import { Header } from "@/components/layout/Header"
import { LanguageSettingsCard } from "@/components/settings/LanguageSettingsCard"
import { normaliseEnabledLocales } from "@/lib/i18n/locales"
import { parseLanguageReviews } from "@/lib/i18n/language-reviews"

export const metadata = {
  title: "Borrower languages — Settings",
}

export default async function LanguageSettingsPage() {
  // Visible to ADMIN and above; only a SUPER_ADMIN changes it.
  const user = await requireMinRole("ADMIN")
  const tenantId = await getStaffTenantId()
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { enabledLanguages: true, languageReviews: true },
  })

  return (
    <>
      <Header
        title="Borrower languages"
        subtitle="Languages offered to this lender's borrowers."
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Borrower languages" },
        ]}
      />
      <div className="p-4 lg:p-8 max-w-4xl space-y-6">
        <LanguageSettingsCard
          enabled={normaliseEnabledLocales(config?.enabledLanguages)}
          reviews={parseLanguageReviews(config?.languageReviews)}
          canChange={user.role === "SUPER_ADMIN"}
        />
      </div>
    </>
  )
}
