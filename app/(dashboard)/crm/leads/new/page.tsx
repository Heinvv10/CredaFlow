import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { LeadForm } from "@/components/crm/LeadForm"
import { getStaffTenantId } from "@/lib/session-tenant"
import { listAssignableStaff } from "@/lib/crm/staff"

export default async function NewLeadPage() {
  // Was an unscoped `active: true` findMany — `User` is not tenant-scoped by
  // the client extension, so it offered every tenant's staff as an assignee.
  const staff = await listAssignableStaff(await getStaffTenantId())

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-4"
          items={[
            { label: "CRM", href: "/crm" },
            { label: "Leads", href: "/crm/leads" },
            { label: "New lead" },
          ]}
        />
        <h1 className="text-2xl font-bold text-gray-900">Add New Lead</h1>
        <p className="text-sm text-gray-400 mt-0.5">Capture a new prospect into the CRM pipeline</p>
      </div>
      <LeadForm staff={staff} />
    </div>
  )
}
