import { notFound, redirect } from "next/navigation"
import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { prisma } from "@/lib/prisma"
import { TOKEN_REGISTRY } from "@/lib/documents/tokens"
import { isLoanDocumentTemplateKey } from "@/lib/non-nca-documents/keys"
import { Breadcrumbs } from "@/components/nav/Breadcrumbs"
import { DocumentTemplateEditor } from "./DocumentTemplateEditor"
import { AssetTemplateEditor } from "./AssetTemplateEditor"
import { assetTemplateEditorProps } from "./asset-template-props"

export const metadata = {
  title: "Edit Document Template — Settings",
}

export default async function EditDocumentTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const user = await requireMinRole("LOAN_ADMIN")
  const { id } = await params
  const tenantId = await getStaffTenantId()

  const template = await prisma.documentTemplate.findFirst({
    where: { id, tenantId, deletedAt: null },
  })
  if (!template) notFound()

  // SYSTEM templates are code-generated NCA/compliance docs — not editable
  // via this HTML editor. The row exists, it just isn't reachable through
  // this route, so redirect rather than 404.
  if (template.kind === "SYSTEM") {
    redirect("/settings/documents")
  }
  if (template.kind === "ASSET_FINANCE") {
    const props = await assetTemplateEditorProps(tenantId, template.id, template.key, user.id, user.role)
    return (
      <div className="p-6 lg:p-8">
        <div className="mb-6">
          <Breadcrumbs
            className="mb-1"
            items={[
              { label: "Settings", href: "/settings" },
              { label: "Document Templates", href: "/settings/documents" },
              { label: template.name },
            ]}
          />
          <h1 className="text-2xl font-bold text-[var(--cf-text)]">{template.name}</h1>
          <p className="text-sm text-[var(--cf-text-muted)] mt-1">Your asset-finance legal wording — {props.variantLabel}</p>
        </div>
        <AssetTemplateEditor {...props} />
      </div>
    )
  }

  // DocumentTemplateVersion has no tenantId column of its own — tenant
  // scoping is enforced by the verified `template.id` above (same pattern
  // as the approve/publish routes).
  const versions = await prisma.documentTemplateVersion.findMany({
    where: { templateId: id },
    orderBy: { version: "desc" },
  })
  const latest = versions[0] ?? null

  const tokens = TOKEN_REGISTRY.map((t) => ({ token: t.token, label: t.label, group: t.group }))

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <Breadcrumbs
          className="mb-1"
          items={[
            { label: "Settings", href: "/settings" },
            { label: "Document Templates", href: "/settings/documents" },
            { label: template.name },
          ]}
        />
        <h1 className="text-2xl font-bold text-[#1b1d24]">{template.name}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {isLoanDocumentTemplateKey(template.key)
            ? "The lender's own legal wording: save a draft, a second admin approves it, then it is published. Documents issued from it are fixed to that version."
            : "Custom letter — HTML editor with token picker"}
        </p>
      </div>

      <DocumentTemplateEditor
        templateId={template.id}
        initialBodyHtml={latest?.bodyHtml ?? ""}
        versions={versions.map((v) => ({
          id: v.id,
          version: v.version,
          status: v.status,
          createdAt: v.createdAt.toISOString(),
          notes: v.notes,
          createdById: v.createdById,
          approvedById: v.approvedById,
          approvedAt: v.approvedAt?.toISOString() ?? null,
        }))}
        tokens={tokens}
        currentUserId={user.id}
        requiresApproval={template.requiresApproval}
      />
    </div>
  )
}
