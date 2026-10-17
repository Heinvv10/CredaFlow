import Link from "next/link"
import { hasMinRole, requireMinRole } from "@/lib/auth-guards"
import { Suspense } from "react"
import { Header } from "@/components/layout/Header"
import { ClientWizard } from "@/components/clients/wizard/ClientWizard"

export default async function NewClientPage() {
  const user = await requireMinRole("READONLY")
  if (!hasMinRole(user.role, "CREDIT_OFFICER")) {
    return <div className="p-6 space-y-3"><h1 className="text-xl font-semibold">Client records are read-only for your role</h1><p>Registering a client requires a credit officer or a role with higher permissions.</p><Link href="/clients" className="underline">Return to clients</Link></div>
  }
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
