/**
 * Real-Postgres helper: adopt the starter wording of every asset-finance
 * family for a test lender, approve each version as a second user and publish
 * it as the first, through the real store (./store.ts) and its database
 * guards. The approval basis is the lender's own: a test tenant that is not
 * a demo lender gets LENDER_LEGAL with a reference that says it is a test
 * fixture, never a legal approval. Not a test file.
 */
import { readFile } from "node:fs/promises"
import type { PrismaClient } from "@prisma/client"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { renderNcaAssetAgreement } from "../nca/agreement-pdf"
import { renderDealDocument } from "../render"
import { pinnedIssuance, readIssuanceInput } from "./issuance"
import { ASSET_TEMPLATE_FAMILIES } from "./families"
import { adoptStarter, approveVersion, publishVersion, type TemplateActor } from "./store"

export const FIXTURE_SIGN_OFF_REFERENCE = "TEST FIXTURE ONLY - not a legal approval"

/**
 * The tenant's synthetic SUPER_ADMIN legal approver, created once and made
 * active for the approval. Callers deactivate it afterwards (endLegalApprovals)
 * so suites that count a lender's active admins (e.g. reminder bells) see only
 * their own staff.
 */
export async function legalApprover(db: PrismaClient, tenantId: string): Promise<string> {
  const email = `legal-approver-${tenantId}@staff.invalid`.toLowerCase()
  const found = await db.user.findFirst({ where: { tenantId, email }, select: { id: true } })
  if (found) {
    await db.user.update({ where: { id: found.id }, data: { active: true } })
    return found.id
  }
  return (await db.user.create({ data: { tenantId, email, password: "x", role: "SUPER_ADMIN" } })).id
}

/** Deactivate the synthetic legal approver again (approvals already recorded stay valid). */
export async function endLegalApprovals(db: PrismaClient, tenantId: string): Promise<void> {
  await db.user.updateMany({ where: { tenantId, email: `legal-approver-${tenantId}@staff.invalid`.toLowerCase() }, data: { active: false } })
}

/** Adopt, approve and publish every family (or `families`) for `tenantId`. Returns template id by key. */
export async function publishStarterTemplates(
  db: PrismaClient,
  tenantId: string,
  authorId: string,
  approverId: string,
  families: readonly string[] = ASSET_TEMPLATE_FAMILIES.map((f) => f.family),
): Promise<Map<string, string>> {
  const author: TemplateActor = { tenantId, userId: authorId, totpVerified: true }
  // A real (non-demo) lender's legal approval is a SUPER_ADMIN's: the fixture adds one.
  const config = await db.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } })
  const approver: TemplateActor = config?.isDemoLender === true
    ? { tenantId, userId: approverId, totpVerified: true }
    : { tenantId, userId: await legalApprover(db, tenantId), totpVerified: true, role: "SUPER_ADMIN" }
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
        contentSha256: version.contentSha256, attestation: true, legalSignOff: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE,
      })
      if (!approved.ok) throw new Error(`approve ${template.key}: ${approved.error}`)
    }
    const published = await publishVersion(author, template.id, version.id)
    if (!published.ok) throw new Error(`publish ${template.key}: ${published.error}`)
  }
  await endLegalApprovals(db, tenantId)
  return ids
}

/**
 * Every current issuance of `dealId`: its stored PDF hashes to pdfSha256 and
 * its retained input, re-rendered with its pinned template version, gives the
 * same bytes. Returns the template keys issued, sorted.
 */
export async function expectReproducibleIssuances(db: PrismaClient, tenantId: string, dealId: string): Promise<string[]> {
  const app = db as unknown as typeof import("@/lib/prisma").prisma
  const issuances = await db.assetDocumentIssuance.findMany({ where: { tenantId, dealId, supersededAt: null } })
  for (const issuance of issuances) {
    const stored = await readFile(issuance.pdfStoragePath!)
    if (sha256DocumentBytes(stored) !== issuance.pdfSha256) throw new Error(`${issuance.templateKey}: stored PDF does not match its hash`)
    const input = await readIssuanceInput(issuance.inputStoragePath!, issuance.inputSha256)
    const pinned = await pinnedIssuance(app, tenantId, issuance.id)
    if (!pinned) throw new Error(`${issuance.templateKey}: no pinned version`)
    const bytes = input.kind === "nca"
      ? await renderNcaAssetAgreement(input.data, pinned.wording)
      : (await renderDealDocument(input.data, input.document, input.clientId, pinned.wording)).bytes
    if (sha256DocumentBytes(bytes) !== issuance.pdfSha256) throw new Error(`${issuance.templateKey}: the retained input does not reproduce the PDF`)
  }
  return issuances.map((i) => i.templateKey).sort()
}
