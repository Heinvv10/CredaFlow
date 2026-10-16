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
    <div className="container mx-auto max-w-4xl py-8 space-y-6">
      <Breadcrumbs
        items={[
          { label: "Settings", href: "/settings" },
          { label: "Integrations" },
        ]}
      />
      <div>
        <h1 className="text-2xl font-bold">Integrations</h1>
        <p className="text-muted-foreground">
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
