import { Suspense } from "react"
import { Header } from "@/components/layout/Header"
import { ClientWizard } from "@/components/clients/wizard/ClientWizard"

export default function NewClientPage() {
  return (
    <>
      <Header
        title="New Client"
        subtitle="Register a new client"
        breadcrumbs={[
          { label: "Clients", href: "/clients" },
          { label: "New client" },
        ]}
      />
      <div className="p-4 lg:p-8">
        <Suspense
          fallback={
            <div className="text-[var(--cf-text-muted)] p-6">Loading…</div>
          }
        >
          <ClientWizard mode="staff" />
        </Suspense>
      </div>
    </>
  )
}
