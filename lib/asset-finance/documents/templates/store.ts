// Adopt, draft, approve and publish a lender's asset-finance templates
// (SPEC.md §3). Every rule here is also a database rule
// (guardAssetTemplateVersion, guardAssetTemplate, DocumentTemplateVersion_one_active),
// so a route that skipped this file would still be refused; this file gives
// the reason in words and audits each transition in the same transaction.
import { Prisma, type DocumentTemplateApprovalBasis } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { demoStaffWithoutTotp, isDemoMode } from "@/lib/config/demo-mode"
import { canonicalContent, contentSha256, parseContent, starterContent, type AssetTemplateContent } from "./content"
import { familyDef, parseTemplateKey } from "./families"
import { systemFingerprint } from "./fingerprint"
import { tokensIn } from "./tokens"
import { contentProblems, validContent, type ContentProblem } from "./validate"

export interface TemplateActor {
  tenantId: string
  userId: string
  userEmail?: string | null
  totpVerified?: boolean
  /** The approver's role: a legal approval is a SUPER_ADMIN's. */
  role?: string
  /** A script acting for a demo lender (prisma/seed, ensure-demo-templates): recorded on every audit row. */
  via?: "seed"
}

export type StoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 403 | 404 | 409 | 422; error: string; problems?: ContentProblem[] }

const refuse = (status: 403 | 404 | 409 | 422, error: string, problems?: ContentProblem[]) => ({ ok: false as const, status, error, ...(problems ? { problems } : {}) })

/** The basis an approval by this lender carries: never chosen by the caller. */
export async function approvalBasisFor(db: Pick<typeof prisma, "tenantConfig">, tenantId: string): Promise<DocumentTemplateApprovalBasis> {
  const config = await db.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } })
  return config?.isDemoLender === true ? "SYNTHETIC_DEMO" : "LENDER_LEGAL"
}

/** Approving or publishing legal wording needs a TOTP-verified session (the TOTP-free demo stack excepted, and audited). */
function totpRefusal(actor: TemplateActor): { status: 403; error: string } | null {
  if (actor.totpVerified === true || demoStaffWithoutTotp()) return null
  return { status: 403, error: "Sign in with two-factor authentication to approve or publish legal wording" }
}

const versionData = (content: AssetTemplateContent) => {
  const text = canonicalContent(content)
  const tokens = [...new Set([...Object.values(content.clauses), ...content.additionalTerms.flatMap((t) => [t.heading, t.text])].flatMap(tokensIn))].sort()
  return { content: text, contentSha256: contentSha256(text), bodyHtml: "", tokensUsed: tokens }
}

class KeyTakenError extends Error {}

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"

/**
 * Adopt the starter wording of `family` as this lender's own: one template per
 * variant with a version-1 draft holding the starter text. Idempotent: a
 * variant the lender already has is left exactly as it is (its wording is
 * never overwritten by the starter, then or later).
 */
export async function adoptStarter(actor: TemplateActor, family: string): Promise<StoreResult<{ created: string[]; existing: string[] }>> {
  const def = familyDef(family)
  if (!def) return refuse(422, "Unknown asset-finance document family")
  const created: string[] = []
  const existing: string[] = []
  for (const { variant, label } of def.variants) {
    const key = parseTemplateKey(`${def.family}.${variant}`)!
    try {
      const made = await prisma.$transaction(async (tx) => {
        const found = await tx.documentTemplate.findFirst({ where: { tenantId: actor.tenantId, key: key.key }, select: { id: true, kind: true } })
        if (found?.kind === "ASSET_FINANCE") return null
        if (found) throw new KeyTakenError(key.key)
        const template = await tx.documentTemplate.create({
          data: {
            tenantId: actor.tenantId, key: key.key, name: `${def.name} — ${label}`, category: "Asset finance", kind: "ASSET_FINANCE",
            requiresApproval: true, assetFamily: def.family, assetVariant: variant, createdById: actor.userId,
          },
        })
        const content = starterContent(key)
        const version = await tx.documentTemplateVersion.create({
          data: { templateId: template.id, version: 1, ...versionData(content), status: "DRAFT", notes: "Adopted from the starter wording", createdById: actor.userId },
        })
        await logAuditStrict({
          tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.ASSET_TEMPLATE_ADOPTED,
          entity: "DocumentTemplate", entityId: template.id,
          newValue: { key: key.key, versionId: version.id, version: 1, contentSha256: version.contentSha256, starterRevision: content.starterRevision, ...(actor.via ? { via: actor.via } : {}) },
        }, tx)
        return template.id
      })
      if (made) created.push(key.key)
      else existing.push(key.key)
    } catch (error) {
      if (error instanceof KeyTakenError) return refuse(409, `Another document template already uses the key ${key.key}; rename it before adopting`)
      // Another adoption of the same variant committed first: it exists.
      if (!isUniqueViolation(error)) throw error
      existing.push(key.key)
    }
  }
  return { ok: true, value: { created, existing } }
}

async function loadTemplate(tenantId: string, templateId: string) {
  return prisma.documentTemplate.findFirst({ where: { id: templateId, tenantId, kind: "ASSET_FINANCE", deletedAt: null } })
}

/** A new draft version of the lender's wording. Versions are immutable: every edit is a new draft needing fresh approval. */
export async function createDraftVersion(
  actor: TemplateActor,
  templateId: string,
  input: { content?: unknown; notes?: string | null },
): Promise<StoreResult<{ id: string; version: number; contentSha256: string }>> {
  const template = await loadTemplate(actor.tenantId, templateId)
  if (!template) return refuse(404, "Not found")
  const parsed = parseContent(JSON.stringify(input.content ?? null))
  if (!parsed) return refuse(422, "The wording is not in the template format", [{ field: "content", message: "The wording is not in the template format" }])
  const problems = contentProblems(template.key, parsed)
  if (problems.length > 0) return refuse(422, "The wording cannot be saved", problems)
  const notes = typeof input.notes === "string" ? input.notes.trim().slice(0, 500) || null : null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return { ok: true, value: await prisma.$transaction(async (tx) => {
        const latest = await tx.documentTemplateVersion.aggregate({ where: { templateId }, _max: { version: true } })
        const version = await tx.documentTemplateVersion.create({
          data: { templateId, version: (latest._max.version ?? 0) + 1, ...versionData(parsed), status: "DRAFT", notes, createdById: actor.userId },
        })
        await logAuditStrict({
          tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.DOCUMENT_TEMPLATE_VERSION_CREATED,
          entity: "DocumentTemplateVersion", entityId: version.id,
          newValue: { templateId, key: template.key, version: version.version, contentSha256: version.contentSha256, tokensUsed: version.tokensUsed },
        }, tx)
        return { id: version.id, version: version.version, contentSha256: version.contentSha256! }
      }) }
    } catch (error) {
      // Two drafts raced for the same number: take the next one.
      if (!isUniqueViolation(error)) throw error
    }
  }
  return refuse(409, "Another draft was saved at the same moment; save again")
}

/**
 * Approve exactly the content the approver previewed (`contentSha256`), for
 * the template's document and variant. Not the author, not twice, drafts only.
 */
export async function approveVersion(
  actor: TemplateActor,
  templateId: string,
  versionId: string,
  input: { contentSha256?: unknown; attestation?: unknown; legalSignOff?: unknown; legalSignOffReference?: unknown },
): Promise<StoreResult<{ approvalBasis: DocumentTemplateApprovalBasis }>> {
  const totp = totpRefusal(actor)
  if (totp) return refuse(totp.status, totp.error)
  const template = await loadTemplate(actor.tenantId, templateId)
  if (!template) return refuse(404, "Not found")
  const version = await prisma.documentTemplateVersion.findFirst({ where: { id: versionId, templateId } })
  if (!version) return refuse(404, "Not found")
  if (version.status !== "DRAFT") return refuse(409, "Only a draft is approved; to change published wording, save a new draft")
  if (version.approvedById) return refuse(409, "This draft is already approved")
  if (version.createdById === actor.userId) return refuse(409, "Cannot approve your own draft")
  if (input.contentSha256 !== version.contentSha256) return refuse(409, "The wording changed since you previewed it; preview this version again before approving")
  if (input.attestation !== true) return refuse(422, "Confirm that you have read the full preview and that the wording changes no fee, rate, schedule, statutory right or system process")
  const checked = validContent(template.key, version.content ?? "")
  if (!checked.ok) return refuse(422, "This version's wording no longer passes the template rules", checked.problems)
  const basis = await approvalBasisFor(prisma, actor.tenantId)
  let reference: string | null = null
  if (basis === "LENDER_LEGAL") {
    if (isDemoMode()) return refuse(403, "A demo deployment cannot record a lender's legal approval")
    // Removing the DRAFT mark is the lender's most senior act: a SUPER_ADMIN
    // records it, on its legal team's written sign-off of this exact version.
    if (actor.role !== "SUPER_ADMIN") return refuse(403, "A legal approval is recorded by a SUPER_ADMIN of your lender")
    if (input.legalSignOff !== true) return refuse(422, "Confirm that your legal team signed off this exact version in writing")
    reference = typeof input.legalSignOffReference === "string" ? input.legalSignOffReference.trim() : ""
    if (reference.length < 5 || reference.length > 200) return refuse(422, "Give the reference of your legal team's written sign-off (5 to 200 characters)")
  }
  const approvedAt = new Date()
  const system = await systemFingerprint(template.key)
  const done = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "DocumentTemplate" WHERE "id" = ${templateId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`)
    const { count } = await tx.documentTemplateVersion.updateMany({
      where: { id: versionId, templateId, status: "DRAFT", approvedById: null, contentSha256: version.contentSha256 },
      data: { approvedById: actor.userId, approvedAt, approvalBasis: basis, approvedContentSha256: version.contentSha256, approvedSystemSha256: system, legalSignOffReference: reference },
    })
    if (count !== 1) return false
    await logAuditStrict({
      tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.DOCUMENT_TEMPLATE_VERSION_APPROVED,
      entity: "DocumentTemplateVersion", entityId: versionId, oldValue: { approvedById: null },
      newValue: {
        templateId, key: template.key, version: version.version, approvedContentSha256: version.contentSha256, approvedSystemSha256: system, approvalBasis: basis,
        legalSignOffReference: reference, attestation: true, ...(basis === "LENDER_LEGAL" ? { legalSignOff: true, approverRole: actor.role } : {}), ...(actor.totpVerified === true ? {} : { totpWaived: "demoStaffWithoutTotp" }), ...(actor.via ? { via: actor.via } : {}),
      },
    }, tx)
    return true
  })
  return done ? { ok: true, value: { approvalBasis: basis } } : refuse(409, "This draft was approved or changed by someone else at the same moment")
}

/** Publish an approved draft: it becomes the one ACTIVE version future documents are issued from. */
export async function publishVersion(actor: TemplateActor, templateId: string, versionId: string): Promise<StoreResult<{ archived: string[] }>> {
  const totp = totpRefusal(actor)
  if (totp) return refuse(totp.status, totp.error)
  const template = await loadTemplate(actor.tenantId, templateId)
  if (!template) return refuse(404, "Not found")
  const basis = await approvalBasisFor(prisma, actor.tenantId)
  const system = await systemFingerprint(template.key)
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`SELECT 1 FROM "DocumentTemplate" WHERE "id" = ${templateId} AND "tenantId" = ${actor.tenantId} FOR UPDATE`)
    const version = await tx.documentTemplateVersion.findFirst({ where: { id: versionId, templateId } })
    if (!version) return refuse(404, "Not found")
    if (version.status === "ACTIVE") return refuse(409, "This version is already published")
    if (version.status !== "DRAFT") return refuse(409, "An archived version is not published again; save it as a new draft and approve it")
    if (!version.approvedById || version.approvedContentSha256 !== version.contentSha256) {
      return refuse(409, "This version requires approval by a second admin before it can be published")
    }
    if (version.approvedById === actor.userId) return refuse(409, "The approver cannot also publish; a different admin must publish")
    if (version.approvalBasis !== basis) return refuse(409, "This approval no longer matches your lender's approval basis; approve a new draft")
    if (version.approvedSystemSha256 !== system) return refuse(409, "CredaFlow's protected wording for this document changed after this approval; save it as a new draft and approve it again")
    const checked = validContent(template.key, version.content ?? "")
    if (!checked.ok) return refuse(422, "This version's wording no longer passes the template rules", checked.problems)
    const previous = await tx.documentTemplateVersion.findMany({ where: { templateId, status: "ACTIVE" }, select: { id: true, version: true } })
    await tx.documentTemplateVersion.updateMany({ where: { templateId, status: "ACTIVE" }, data: { status: "ARCHIVED" } })
    await tx.documentTemplateVersion.update({ where: { id: versionId }, data: { status: "ACTIVE", activatedById: actor.userId, activatedAt: new Date() } })
    await tx.documentTemplate.update({ where: { id: templateId, tenantId: actor.tenantId }, data: { currentVersionId: versionId } })
    for (const prev of previous) {
      await logAuditStrict({
        tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.DOCUMENT_TEMPLATE_VERSION_ARCHIVED,
        entity: "DocumentTemplateVersion", entityId: prev.id, oldValue: { status: "ACTIVE" }, newValue: { status: "ARCHIVED", templateId, key: template.key },
      }, tx)
    }
    await logAuditStrict({
      tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined, action: AuditAction.DOCUMENT_TEMPLATE_VERSION_PUBLISHED,
      entity: "DocumentTemplateVersion", entityId: versionId,
      newValue: {
        templateId, key: template.key, version: version.version, contentSha256: version.contentSha256, approvalBasis: version.approvalBasis,
        archived: previous.map((p) => p.id), ...(actor.totpVerified === true ? {} : { totpWaived: "demoStaffWithoutTotp" }), ...(actor.via ? { via: actor.via } : {}),
      },
    }, tx)
    return { ok: true as const, value: { archived: previous.map((p) => p.id) } }
  })
}
