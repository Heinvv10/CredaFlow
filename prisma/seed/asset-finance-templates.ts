/**
 * The demo lender's asset-finance templates: the starter wording of every
 * family adopted, approved by adminTwo and published by adminOne through the
 * real store (lib/asset-finance/documents/templates/store.ts). Their approval
 * is SYNTHETIC_DEMO, so every issued page keeps the synthetic demo watermark.
 * Refuses a lender that is not a demo lender: a seed never records a legal
 * approval. Idempotent.
 */
import { prisma } from "@/lib/prisma"
import { ASSET_TEMPLATE_FAMILIES } from "@/lib/asset-finance/documents/templates/families"
import { adoptStarter, approvalBasisFor, approveVersion, publishVersion } from "@/lib/asset-finance/documents/templates/store"
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
}
