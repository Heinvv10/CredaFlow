import { IntegrationsTab } from "@/components/settings/IntegrationsTab"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { PayoutSettingsCard } from "@/components/settings/PayoutSettingsCard"
import { XeroConnectionCard } from "@/components/settings/XeroConnectionCard"
import { IsaFlowConnectionCard } from "@/components/settings/IsaFlowConnectionCard"

export const metadata = {
  title: "Integrations — Settings",
}

export default async function IntegrationsSettingsPage({ searchParams }: { searchParams: Promise<{ xero?: string }> }) {
  const { xero } = await searchParams
  return (
    <div className="w-full max-w-4xl space-y-6 p-4 lg:p-8">
      <Breadcrumbs
        items={[
          { label: "Settings", href: "/settings" },
          { label: "Integrations" },
        ]}
      />
      <div>
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--cf-text-muted)]">
          Configure external service integrations for SMS, payments, credit checks, and ID verification.
        </p>
      </div>
      <IntegrationsTab />
      <PayoutSettingsCard />
      <XeroConnectionCard returned={xero ?? null} />
      <IsaFlowConnectionCard />
    </div>
  )
}
