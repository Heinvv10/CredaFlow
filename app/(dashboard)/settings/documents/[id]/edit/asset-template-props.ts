// The server half of the asset-finance template editor: versions, people and
// the family's editable surface, read for the signed-in lender only.
import { prisma } from "@/lib/prisma"
import { parseContent } from "@/lib/asset-finance/documents/templates/content"
import { additionalTermNumber, editableClauses, parseTemplateKey, STARTER_REVISION, takesLenderText } from "@/lib/asset-finance/documents/templates/families"
import { ASSET_TEMPLATE_TOKENS } from "@/lib/asset-finance/documents/templates/tokens"
import type { AssetTemplateEditorProps } from "./asset-template-types"

export async function assetTemplateEditorProps(tenantId: string, templateId: string, templateKey: string, currentUserId: string, currentUserRole: string): Promise<AssetTemplateEditorProps> {
  const key = parseTemplateKey(templateKey)
  if (!key) throw new Error(`Not an asset-finance template: ${templateKey}`)
  // DocumentTemplateVersion has no tenantId: scoped by the caller's verified template.
  const [versions, config] = await Promise.all([
    prisma.documentTemplateVersion.findMany({ where: { templateId }, orderBy: { version: "desc" } }),
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } }),
  ])
  const ids = [...new Set(versions.flatMap((v) => [v.createdById, v.approvedById, v.activatedById]).filter((u): u is string => !!u))]
  const users = await prisma.user.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true, email: true } })
  const who = (id: string | null) => (id ? users.find((u) => u.id === id)?.name?.trim() || users.find((u) => u.id === id)?.email || "Unknown user" : null)
  const editableNumbers = editableClauses(key).map((c) => c.number)
  return {
    templateId, templateKey,
    variantLabel: key.family.variants.find((v) => v.variant === key.variant)?.label ?? key.variant,
    editable: editableClauses(key).map((c) => ({ id: c.id, number: c.number, heading: c.heading, starter: c.starter, requiredTokens: [...c.requiredTokens] })),
    protectedSummary: takesLenderText(key)
      ? `Every section, particular, figure and schedule, the statutory and Consumer Protection Act notices, and every numbered clause except ${editableNumbers.join(", ")} are printed by the system from the deal.`
      : "This document takes no lender text: its wording is the protected starter (Consumer Protection Act, National Credit Act, suretyship and resolution formalities). Your version approves that wording for your lender.",
    takesLenderText: takesLenderText(key),
    tokens: key.family.tokens.map((token) => ({ token, label: ASSET_TEMPLATE_TOKENS[token] })),
    firstAdditionalNumber: additionalTermNumber(key.family, key.variant, 0),
    currentUserId,
    currentUserRole,
    isDemoLender: config?.isDemoLender === true,
    starterRevision: STARTER_REVISION,
    versions: versions.flatMap((v) => {
      const content = v.content ? parseContent(v.content) : null
      if (!content || !v.contentSha256) return []
      return [{
        id: v.id, version: v.version, status: v.status, createdAt: v.createdAt.toISOString(), createdById: v.createdById, createdBy: who(v.createdById) ?? "Unknown user",
        notes: v.notes, contentSha256: v.contentSha256, content, approvedById: v.approvedById, approvedBy: who(v.approvedById),
        approvedAt: v.approvedAt?.toISOString() ?? null, approvalBasis: v.approvalBasis, legalSignOffReference: v.legalSignOffReference,
        activatedBy: who(v.activatedById), activatedAt: v.activatedAt?.toISOString() ?? null,
      }]
    }),
  }
}
