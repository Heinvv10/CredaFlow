import { IntegrationsTab } from "@/components/settings/IntegrationsTab"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"

export const metadata = {
  title: "Integrations — Settings",
}

export default function IntegrationsSettingsPage() {
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
    </div>
  )
}
