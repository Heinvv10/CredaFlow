/**
 * Real-Postgres helper: adopt the starter wording of every asset-finance
 * family for a test lender, approve each version as a second user and publish
 * it as the first, through the real store (./store.ts) and its database
 * guards. The approval basis is the lender's own: a test tenant that is not
 * a demo lender gets LENDER_LEGAL with a reference that says it is a test
 * fixture, never a legal approval. Not a test file.
 */
import type { PrismaClient } from "@prisma/client"
import { ASSET_TEMPLATE_FAMILIES } from "./families"
import { adoptStarter, approveVersion, publishVersion, type TemplateActor } from "./store"

export const FIXTURE_SIGN_OFF_REFERENCE = "TEST FIXTURE ONLY - not a legal approval"

/** Adopt, approve and publish every family (or `families`) for `tenantId`. Returns template id by key. */
export async function publishStarterTemplates(
  db: PrismaClient,
  tenantId: string,
  authorId: string,
  approverId: string,
  families: readonly string[] = ASSET_TEMPLATE_FAMILIES.map((f) => f.family),
): Promise<Map<string, string>> {
  const author: TemplateActor = { tenantId, userId: authorId, totpVerified: true }
  const approver: TemplateActor = { tenantId, userId: approverId, totpVerified: true }
  for (const family of families) {
    const adopted = await adoptStarter(author, family)
    if (!adopted.ok) throw new Error(`adopt ${family}: ${adopted.error}`)
  }
  const templates = await db.documentTemplate.findMany({
    where: { tenantId, kind: "ASSET_FINANCE", assetFamily: { in: [...families] } },
    include: { versions: { orderBy: { version: "desc" }, take: 1 } },
  })
  const ids = new Map<string, string>()
  for (const template of templates) {
    ids.set(template.key, template.id)
    const version = template.versions[0]
    if (template.currentVersionId === version.id) continue
    if (!version.approvedById) {
      const approved = await approveVersion(approver, template.id, version.id, {
        contentSha256: version.contentSha256, attestation: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE,
      })
      if (!approved.ok) throw new Error(`approve ${template.key}: ${approved.error}`)
    }
    const published = await publishVersion(author, template.id, version.id)
    if (!published.ok) throw new Error(`publish ${template.key}: ${published.error}`)
  }
  return ids
}
