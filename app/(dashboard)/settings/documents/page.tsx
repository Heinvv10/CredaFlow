import { requireMinRole } from "@/lib/auth-guards"
import { getDefaultTenantId } from "@/lib/tenant"
import { listTemplates } from "@/lib/documents/catalogue"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DocumentTemplatesTable } from "./DocumentTemplatesTable"

export const metadata = {
  title: "Document Templates — Settings",
}

export default async function DocumentTemplatesPage() {
  await requireMinRole("LOAN_ADMIN")
  const tenantId = await getDefaultTenantId()
  const templates = await listTemplates(tenantId)

  return (
    <div className="p-6 lg:p-8">
      {/* Header */}
      <div className="mb-6">
        <Breadcrumbs
          className="mb-1"
          items={[
            { label: "Settings", href: "/settings" },
            { label: "Document Templates" },
          ]}
        />
        <h1 className="text-2xl font-bold text-[#1b1d24]">Document Templates</h1>
        <p className="text-sm text-gray-500 mt-1">
          {templates.length} template{templates.length !== 1 ? "s" : ""} — NCA-mandated system
          documents and custom letters
        </p>
      </div>

      <DocumentTemplatesTable
        templates={templates.map((t) => ({
          id: t.id,
          key: t.key,
          name: t.name,
          kind: t.kind,
          isActive: t.isActive,
          currentVersionIsActive: t.versions.some((version) => version.id === t.currentVersionId),
        }))}
      />
    </div>
  )
}
