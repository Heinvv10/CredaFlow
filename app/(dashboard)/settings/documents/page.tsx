import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { listTemplates } from "@/lib/documents/catalogue"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DocumentTemplatesTable } from "./DocumentTemplatesTable"
import { prisma } from "@/lib/prisma"
import { ASSET_TEMPLATE_FAMILIES } from "@/lib/asset-finance/documents/templates/families"
import { AssetTemplateFamilies, type AssetFamilyRow } from "@/components/settings/AssetTemplateFamilies"
import { LoanDocumentTemplates, type LoanDocumentTemplateRow } from "@/components/settings/LoanDocumentTemplates"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { LOAN_DOCUMENT_KINDS, LOAN_DOCUMENT_LABELS, LOAN_DOCUMENT_TEMPLATE_KEYS } from "@/lib/non-nca-documents/keys"

export const metadata = {
  title: "Document Templates — Settings",
}

export default async function DocumentTemplatesPage() {
  await requireMinRole("LOAN_ADMIN")
  const tenantId = await getStaffTenantId()
  const templates = await listTemplates(tenantId)
  const assetTemplates = await prisma.documentTemplate.findMany({
    where: { tenantId, kind: "ASSET_FINANCE" },
    select: { id: true, key: true, currentVersionId: true, versions: { where: { status: "ACTIVE" }, select: { version: true } } },
  })
  const families: AssetFamilyRow[] = ASSET_TEMPLATE_FAMILIES.map((f) => ({
    family: f.family,
    name: f.name,
    variants: f.variants.map((v) => {
      const row = assetTemplates.find((t) => t.key === `${f.family}.${v.variant}`)
      return { key: `${f.family}.${v.variant}`, label: v.label, templateId: row?.id ?? null, published: row?.versions[0]?.version ?? null }
    }),
  }))

  // A lender outside the NCA signs on its own key facts statement and loan agreement (lib/non-nca-documents).
  const loanDocumentRows: LoanDocumentTemplateRow[] | null = isNcaJurisdiction()
    ? null
    : await Promise.all(LOAN_DOCUMENT_KINDS.map(async (kind) => {
        const key = LOAN_DOCUMENT_TEMPLATE_KEYS[kind]
        const template = await prisma.documentTemplate.findFirst({ where: { tenantId, key, deletedAt: null }, select: { id: true, currentVersionId: true } })
        const versions = template ? await prisma.documentTemplateVersion.findMany({ where: { templateId: template.id }, select: { id: true, version: true, status: true, approvedById: true } }) : []
        return {
          key, name: LOAN_DOCUMENT_LABELS[kind], templateId: template?.id ?? null,
          published: versions.find((v) => v.id === template?.currentVersionId && v.status === "ACTIVE")?.version ?? null,
          drafts: versions.filter((v) => v.status === "DRAFT").length,
          awaitingApproval: versions.filter((v) => v.status === "DRAFT" && !v.approvedById).length,
        }
      }))

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

      {loanDocumentRows && <LoanDocumentTemplates rows={loanDocumentRows} />}

      <AssetTemplateFamilies families={families} />

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
