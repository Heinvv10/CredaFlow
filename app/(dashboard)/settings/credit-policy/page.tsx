import { requireMinRole } from "@/lib/auth-guards"
import { CreditPolicyForm } from "@/components/settings/CreditPolicyForm"
import { BureauSettingsForm } from "@/components/settings/BureauSettingsForm"
import { Header } from "@/components/layout/Header"
import { StatementAiToggle } from "@/components/settings/StatementAiToggle"
import { getStaffTenantId } from "@/lib/session-tenant"
import { statementAiEnabled } from "@/lib/statement-ai/enabled"

export const metadata = {
  title: "Credit Policy — Settings",
}

export default async function CreditPolicySettingsPage() {
  const user = await requireMinRole("ADMIN")
  const enabled = await statementAiEnabled(await getStaffTenantId())

  return (
    <>
      <Header
        title="Credit Policy"
        subtitle="Configure the bureau score gate, affordability buffer, credit bureaus and report freshness applied when deciding applications."
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Credit Policy" },
        ]}
      />
      <div className="p-4 lg:p-8 max-w-4xl space-y-6">
        <CreditPolicyForm />
        <BureauSettingsForm />
        <StatementAiToggle enabled={enabled} canChange={user.role === "SUPER_ADMIN"} />
      </div>
    </>
  )
}
