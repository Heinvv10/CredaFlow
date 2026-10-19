/**
 * The demo lender's asset-finance templates: the starter wording of every
 * family adopted, approved by adminTwo and published by adminOne through the
 * real store (lib/asset-finance/documents/templates/store.ts). Their approval
 * is SYNTHETIC_DEMO, so every issued page keeps the synthetic demo watermark.
 * Refuses a lender that is not a demo lender: a seed never records a legal
 * approval. Idempotent. A published version whose approval lapsed because
 * CredaFlow's protected wording changed (fingerprint.ts) is approved again as a
 * new version with the same lender wording, so a demo stack recovers without
 * a re-bake.
 */
import { prisma } from "@/lib/prisma"
import { parseContent } from "@/lib/asset-finance/documents/templates/content"
import { ASSET_TEMPLATE_FAMILIES } from "@/lib/asset-finance/documents/templates/families"
import { systemFingerprint } from "@/lib/asset-finance/documents/templates/fingerprint"
import { adoptStarter, approvalBasisFor, approveVersion, createDraftVersion, publishVersion } from "@/lib/asset-finance/documents/templates/store"
import type { SeedStaff } from "./asset-finance-deal"

export async function ensureSyntheticTemplates(tenantId: string, staff: Pick<SeedStaff, "adminOne" | "adminTwo">): Promise<void> {
  if (await approvalBasisFor(prisma, tenantId) !== "SYNTHETIC_DEMO") {
    throw new Error("Seed: asset-finance templates are approved only for a synthetic demo lender (TenantConfig.isDemoLender)")
  }
  // Scripted, not signed in: every audit row says via "seed".
  const author = { tenantId, userId: staff.adminOne.id, userEmail: staff.adminOne.email, totpVerified: true, via: "seed" as const }
  const approver = { tenantId, userId: staff.adminTwo.id, userEmail: staff.adminTwo.email, totpVerified: true, via: "seed" as const }
  for (const { family } of ASSET_TEMPLATE_FAMILIES) {
    const adopted = await adoptStarter(author, family)
    if (!adopted.ok) throw new Error(`Seed: adopt ${family}: ${adopted.error}`)
  }
  const templates = await prisma.documentTemplate.findMany({
    where: { tenantId, kind: "ASSET_FINANCE", currentVersionId: null },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  })
  for (const template of templates) {
    const version = template.versions[0]
    if (!version.approvedById) {
      const approved = await approveVersion(approver, template.id, version.id, { contentSha256: version.contentSha256, attestation: true })
      if (!approved.ok) throw new Error(`Seed: approve ${template.key}: ${approved.error}`)
    }
    const published = await publishVersion(author, template.id, version.id)
    if (!published.ok) throw new Error(`Seed: publish ${template.key}: ${published.error}`)
  }
  const current = await prisma.documentTemplate.findMany({
    where: { tenantId, kind: "ASSET_FINANCE", currentVersionId: { not: null } },
    select: { id: true, key: true, currentVersionId: true },
  })
  for (const template of current) {
    const active = await prisma.documentTemplateVersion.findUniqueOrThrow({ where: { id: template.currentVersionId! }, select: { content: true, approvedSystemSha256: true } })
    if (active.approvedSystemSha256 === await systemFingerprint(template.key)) continue
    const content = parseContent(active.content ?? "")
    if (!content) throw new Error(`Seed: ${template.key}: the published wording is not in the template format`)
    const draft = await createDraftVersion(author, template.id, { content, notes: "Re-approved after a CredaFlow protected wording change" })
    if (!draft.ok) throw new Error(`Seed: redraft ${template.key}: ${draft.error}`)
    const approved = await approveVersion(approver, template.id, draft.value.id, { contentSha256: draft.value.contentSha256, attestation: true })
    if (!approved.ok) throw new Error(`Seed: re-approve ${template.key}: ${approved.error}`)
    const published = await publishVersion(author, template.id, draft.value.id)
    if (!published.ok) throw new Error(`Seed: republish ${template.key}: ${published.error}`)
  }
}
