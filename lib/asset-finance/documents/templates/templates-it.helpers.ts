/**
 * Shared helpers of the two real-Postgres template suites
 * (templates-governance / templates-issuance .integration.test.ts): the
 * template routes called through a host that resolves to the tenant, and the
 * draft → legal approval → publication sequence. Not a test file.
 */
import { createHash } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { POST as adoptRoute } from "@/app/api/documents/templates/asset-finance/adopt/route"
import { DELETE as deleteRoute, PATCH as patchRoute } from "@/app/api/documents/templates/[id]/route"
import { POST as previewRoute } from "@/app/api/documents/templates/[id]/preview/route"
import { POST as versionsRoute } from "@/app/api/documents/templates/[id]/versions/route"
import { POST as approveRoute } from "@/app/api/documents/templates/[id]/versions/[versionId]/approve/route"
import { POST as publishRoute } from "@/app/api/documents/templates/[id]/versions/[versionId]/publish/route"
import { starterContent, type AssetTemplateContent } from "./content"
import { parseTemplateKey } from "./families"
import { approveVersion, createDraftVersion, publishVersion, type TemplateActor } from "./store"
import { endLegalApprovals, FIXTURE_SIGN_OFF_REFERENCE, legalApprover } from "./templates.integration-fixture"

export async function sqlError(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return String(error instanceof Error ? error.message : error)
  }
  throw new Error("expected the database to refuse")
}

export const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

/** The starter of `key` with one lender additional term (commercial agreement variants only). */
export const edited = (key: string, marker: string): AssetTemplateContent => ({
  ...starterContent(parseTemplateKey(key)!),
  additionalTerms: [{ heading: `${marker} site visits`, text: `${marker}: {{lender.legalName}} may inspect the goods on reasonable notice.` }],
})

export const templateOf = (db: PrismaClient, tenantId: string, key: string) =>
  db.documentTemplate.findFirstOrThrow({ where: { tenantId, key } })

export const latest = (db: PrismaClient, templateId: string) =>
  db.documentTemplateVersion.findFirstOrThrow({ where: { templateId }, orderBy: { version: "desc" } })

/** The tenant's SUPER_ADMIN, as the actor of a legal approval. */
export async function legalActor(db: PrismaClient, tenantId: string): Promise<TemplateActor> {
  return { tenantId, userId: await legalApprover(db, tenantId), totpVerified: true, role: "SUPER_ADMIN" }
}

export const legalInput = (contentSha256: string | null) => ({ contentSha256, attestation: true, legalSignOff: true, legalSignOffReference: FIXTURE_SIGN_OFF_REFERENCE })

/** Save `content` as a new draft by `authorId`, approve it (legal, or as `demoApproverId` for a demo lender) and publish it as the author. */
export async function draftApprovePublish(
  db: PrismaClient,
  tenantId: string,
  templateId: string,
  content: AssetTemplateContent,
  authorId: string,
  demoApproverId?: string,
): Promise<string> {
  const author: TemplateActor = { tenantId, userId: authorId, totpVerified: true }
  const draft = await createDraftVersion(author, templateId, { content })
  if (!draft.ok) throw new Error(draft.error)
  const approver = demoApproverId ? { tenantId, userId: demoApproverId, totpVerified: true } : await legalActor(db, tenantId)
  const approved = await approveVersion(approver, templateId, draft.value.id, legalInput(draft.value.contentSha256))
  if (!approved.ok) throw new Error(approved.error)
  const published = await publishVersion(author, templateId, draft.value.id)
  if (!published.ok) throw new Error(published.error)
  if (!demoApproverId) await endLegalApprovals(db, tenantId)
  return draft.value.id
}

/** The template routes, called as the session the suite has signed in. */
export function templateRoutes(host: string) {
  const request = (path: string, method: string, json?: unknown) => new NextRequest(`http://${host}${path}`, {
    method, headers: { host, ...(json !== undefined ? { "content-type": "application/json" } : {}) }, body: json !== undefined ? JSON.stringify(json) : undefined,
  })
  const base = (id: string) => `/api/documents/templates/${id}`
  const one = (id: string) => ({ params: Promise.resolve({ id }) })
  const both = (id: string, versionId: string) => ({ params: Promise.resolve({ id, versionId }) })
  return {
    adopt: (family: string) => adoptRoute(request("/api/documents/templates/asset-finance/adopt", "POST", { family })),
    patch: (id: string, json: unknown) => patchRoute(request(base(id), "PATCH", json), one(id)),
    remove: (id: string) => deleteRoute(request(base(id), "DELETE"), one(id)),
    preview: (id: string, json: unknown) => previewRoute(request(`${base(id)}/preview`, "POST", json), one(id)),
    saveDraft: (id: string, json: unknown) => versionsRoute(request(`${base(id)}/versions`, "POST", json), one(id)),
    approve: (id: string, versionId: string, json: unknown) => approveRoute(request(`${base(id)}/versions/${versionId}/approve`, "POST", json), both(id, versionId)),
    publish: (id: string, versionId: string) => publishRoute(request(`${base(id)}/versions/${versionId}/publish`, "POST", {}), both(id, versionId)),
  }
}
