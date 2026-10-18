// Issuing an asset-finance document from the lender's template (SPEC.md §4).
//
// selectIssuableTemplate is the only way a document reaches a signer: the
// lender's published, approved version of the template that fits the deal,
// or a refusal. There is no fallback to the starter wording or to another
// lender. The chosen version, the lender identity used and the exact render
// input are retained with the PDF (AssetDocumentIssuance), and every later
// re-render (e-sign, contract) uses that pinned version and identity, so a
// newer publication never changes a document already issued.
import type { DealDocumentKind, DocumentTemplateApprovalBasis, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { readFile, saveFile } from "@/lib/storage"
import { DealDocumentError, type AnyDealDocumentData } from "../deal-document-data"
import type { NcaAssetDocumentData } from "../nca/types"
import type { AppliedWording } from "./apply"
import { contentSha256, parseContent, type AssetTemplateContent } from "./content"
import { SYSTEM_REVISION, parseTemplateKey } from "./families"
import { systemFingerprint } from "./fingerprint"
import { validContent } from "./validate"

type Db = Pick<typeof prisma, "documentTemplate" | "documentTemplateVersion" | "tenantConfig">

/** No approved, published template can issue this document: the reason is shown to staff. */
export class TemplateNotIssuableError extends DealDocumentError {
  constructor(message: string) {
    super(message)
    this.name = "TemplateNotIssuableError"
  }
}

export interface SelectedTemplate {
  templateId: string
  templateKey: string
  versionId: string
  versionNumber: number
  content: AssetTemplateContent
  contentSha256: string
  approvalBasis: DocumentTemplateApprovalBasis
  approvedById: string
  approvedAt: Date
  legalSignOffReference: string | null
  /** The protected-output fingerprint the approval covers (= the current one). */
  systemSha256: string
}

/** The template variant a deal document is issued from. */
export function templateKeyFor(data: AnyDealDocumentData, document: DealDocumentKind): string {
  if (document === "RESOLUTION") return "af.resolution.standard"
  if (document === "SURETYSHIP") return data.ncaApplies ? "af.suretyship.nca" : "af.suretyship.commercial"
  if (data.lease) {
    const family = data.lease.contractType === "FULL_MAINTENANCE_LEASE" ? "af.lease.fml" : "af.lease.operating"
    return `${family}.${data.lease.cpaApplies ? "cpa" : "commercial"}`
  }
  return data.isaCpaApplies !== false ? "af.isa.cpa" : "af.isa.commercial"
}

export function ncaTemplateKey(contractType: "INSTALMENT_SALE" | "FINANCE_LEASE"): string {
  return contractType === "FINANCE_LEASE" ? "af.nca.finance_lease" : "af.nca.instalment_sale"
}

/** What the issued pages carry: a demo approval keeps its demo watermark; a lender's legal approval prints none. */
export function issuedWording(selected: Pick<SelectedTemplate, "templateKey" | "content" | "approvalBasis">): AppliedWording {
  return { templateKey: selected.templateKey, content: selected.content, mark: selected.approvalBasis === "SYNTHETIC_DEMO" ? "SYNTHETIC_DEMO" : "NONE" }
}

function label(templateKey: string): string {
  const key = parseTemplateKey(templateKey)
  const variant = key?.family.variants.find((v) => v.variant === key.variant)
  return key ? `${key.family.name} (${variant?.label ?? key.variant})` : templateKey
}

/**
 * The lender's published, approved version of `templateKey`, or a refusal
 * naming what is missing. Read again inside the issuing transaction
 * (lockSelectedTemplate) and enforced by the database on insert.
 */
export async function selectIssuableTemplate(db: Db, tenantId: string, templateKey: string): Promise<SelectedTemplate> {
  const name = label(templateKey)
  const template = await db.documentTemplate.findFirst({
    where: { tenantId, key: templateKey, kind: "ASSET_FINANCE", deletedAt: null },
    select: { id: true, currentVersionId: true },
  })
  if (!template) throw new TemplateNotIssuableError(`Your ${name} template has not been adopted. Adopt it under Settings → Document templates, then approve and publish it.`)
  if (!template.currentVersionId) throw new TemplateNotIssuableError(`Your ${name} template has no published version. Approve and publish a version first.`)
  const version = await db.documentTemplateVersion.findFirst({ where: { id: template.currentVersionId, templateId: template.id } })
  if (!version || version.status !== "ACTIVE" || !version.approvedById || !version.approvedAt || !version.approvalBasis
    || !version.contentSha256 || version.approvedContentSha256 !== version.contentSha256 || !version.content
    || contentSha256(version.content) !== version.contentSha256) {
    throw new TemplateNotIssuableError(`Your published ${name} template version is not approved for this exact wording. Approve and publish a version first.`)
  }
  const config = await db.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } })
  const basis: DocumentTemplateApprovalBasis = config?.isDemoLender === true ? "SYNTHETIC_DEMO" : "LENDER_LEGAL"
  if (version.approvalBasis !== basis) {
    throw new TemplateNotIssuableError(`Your published ${name} template was approved as ${version.approvalBasis === "SYNTHETIC_DEMO" ? "a synthetic demo" : "a legal approval"}, which does not apply to this lender. Approve and publish a new version.`)
  }
  const checked = validContent(templateKey, version.content)
  if (!checked.ok) throw new TemplateNotIssuableError(`Your published ${name} template no longer passes the template rules: ${checked.problems[0].message}.`)
  const system = await systemFingerprint(templateKey)
  if (version.approvedSystemSha256 !== system) {
    throw new TemplateNotIssuableError(`CredaFlow's protected wording for your ${name} changed after your approval. Approve and publish a new version.`)
  }
  return {
    templateId: template.id, templateKey, versionId: version.id, versionNumber: version.version, content: checked.content,
    contentSha256: version.contentSha256, approvalBasis: version.approvalBasis, approvedById: version.approvedById,
    approvedAt: version.approvedAt, legalSignOffReference: version.legalSignOffReference, systemSha256: system,
  }
}

/**
 * An NCA agreement under a lender's legal approval may not follow a quotation
 * that printed DRAFT (its wording is governed by
 * TenantConfig.assetFinanceLegalWordingApproved). What decides is the mark of
 * the quotation actually issued and acknowledged, recorded on its
 * ASSET_NCA_QUOTE_ISSUED audit row; a quotation without that record counts as
 * DRAFT.
 */
export async function ncaQuoteMarkProblem(
  db: Pick<typeof prisma, "auditLog">,
  tenantId: string,
  dealId: string,
  quoteSha256: string | null,
  selected: Pick<SelectedTemplate, "approvalBasis">,
): Promise<string | null> {
  if (selected.approvalBasis !== "LENDER_LEGAL") return null
  const issued = quoteSha256 === null ? null : await db.auditLog.findFirst({
    where: { tenantId, entity: "AssetFinanceDeal", entityId: dealId, action: "ASSET_NCA_QUOTE_ISSUED", newValue: { path: ["documentSha256"], equals: quoteSha256 } },
    orderBy: { createdAt: "desc" }, select: { newValue: true },
  })
  const draft = (issued?.newValue as { draftLegalWording?: unknown } | null)?.draftLegalWording !== false
  return draft
    ? "The quotation this consumer acknowledged printed DRAFT legal wording, so an unwatermarked agreement cannot follow it. Issue a new quotation once CredaFlow has recorded your legal team's approval of the quotation and notices."
    : null
}

type Tx = Pick<Parameters<Parameters<typeof prisma.$transaction>[0]>[0], "$queryRaw" | "assetDocumentIssuance">

/** Inside the issuing transaction: the version selected is still the one published (shared lock against a concurrent publish). */
export async function lockSelectedTemplate(tx: Tx, tenantId: string, selected: SelectedTemplate): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ currentVersionId: string | null }>>`
    SELECT "currentVersionId" FROM "DocumentTemplate" WHERE "id" = ${selected.templateId} AND "tenantId" = ${tenantId} FOR SHARE`
  if (rows[0]?.currentVersionId !== selected.versionId) {
    throw new TemplateNotIssuableError(`A new version of your ${label(selected.templateKey)} template was published while the documents were being prepared. Prepare them again.`)
  }
}

/** The render input, retained (encrypted at rest) so the PDF can be reproduced. Dates as ISO strings. */
export type RenderInput =
  | { kind: "deal"; document: DealDocumentKind; clientId: string; data: AnyDealDocumentData }
  | { kind: "nca"; document: "AGREEMENT"; clientId: string; data: NcaAssetDocumentData }

export function serializeRenderInput(input: RenderInput): Buffer {
  return Buffer.from(JSON.stringify({ schema: 1, ...input }), "utf8")
}

export function deserializeRenderInput(bytes: Buffer): RenderInput {
  const parsed = JSON.parse(bytes.toString("utf8"), (key, value) => (key === "documentDate" && typeof value === "string" ? new Date(value) : value)) as RenderInput & { schema: number }
  if (parsed.schema !== 1) throw new RangeError("Unknown render input snapshot")
  const { schema: _schema, ...input } = parsed
  return input as RenderInput
}

export interface PreparedIssuance {
  selected: SelectedTemplate
  input: RenderInput
  lenderIdentity: Prisma.InputJsonValue
  inputSha256: string
  inputStoragePath: string
  pdfSha256: string
  pdfStoragePath: string
}

/** Store the input snapshot and PDF bytes (before the transaction, like the PDFs today). */
export async function storeIssuanceFiles(selected: SelectedTemplate, input: RenderInput, pdf: Buffer): Promise<PreparedIssuance> {
  const inputBytes = serializeRenderInput(input)
  const [inputFile, pdfFile] = await Promise.all([saveFile(inputBytes, "application/json"), saveFile(pdf, "application/pdf")])
  return {
    selected, input, lenderIdentity: input.data.lender as unknown as Prisma.InputJsonValue,
    inputSha256: sha256DocumentBytes(inputBytes), inputStoragePath: inputFile.storagePath,
    pdfSha256: sha256DocumentBytes(pdf), pdfStoragePath: pdfFile.storagePath,
  }
}

/** Insert the issuance row (inside the transaction, after lockSelectedTemplate). */
export async function recordIssuance(tx: Tx, tenantId: string, dealId: string, issuedById: string | null, prepared: PreparedIssuance): Promise<string> {
  const s = prepared.selected
  const row = await tx.assetDocumentIssuance.create({
    data: {
      tenantId, dealId, document: prepared.input.document, clientId: prepared.input.document === "SURETYSHIP" ? prepared.input.clientId : null,
      templateKey: s.templateKey, templateId: s.templateId, templateVersionId: s.versionId, templateVersionNumber: s.versionNumber,
      templateContentSha256: s.contentSha256, approvalBasis: s.approvalBasis, approvedById: s.approvedById, approvedAt: s.approvedAt,
      legalSignOffReference: s.legalSignOffReference, systemRevision: SYSTEM_REVISION, systemSha256: s.systemSha256, lenderIdentity: prepared.lenderIdentity,
      inputSha256: prepared.inputSha256, inputStoragePath: prepared.inputStoragePath, pdfSha256: prepared.pdfSha256,
      pdfStoragePath: prepared.pdfStoragePath, issuedById,
    },
    select: { id: true },
  })
  return row.id
}

/**
 * Mark a deal's current issuances superseded (an unsigned preparation being
 * replaced) and return their files to delete. The database refuses this for a
 * signed one. Hashes, version and approval stay on the row.
 */
export async function supersedeIssuances(tx: Tx, tenantId: string, dealId: string, now: Date): Promise<string[]> {
  const rows = await tx.assetDocumentIssuance.findMany({
    where: { tenantId, dealId, supersededAt: null },
    select: { id: true, inputStoragePath: true, pdfStoragePath: true },
  })
  for (const row of rows) {
    await tx.assetDocumentIssuance.update({ where: { id: row.id, tenantId }, data: { supersededAt: now, inputStoragePath: null, pdfStoragePath: null } })
  }
  return rows.flatMap((r) => [r.inputStoragePath, r.pdfStoragePath]).filter((p): p is string => p !== null)
}

/** The wording and identity an issued document was rendered with, for a re-render check. Null for a pre-template row. */
export async function pinnedIssuance(
  db: Pick<typeof prisma, "assetDocumentIssuance" | "documentTemplateVersion">,
  tenantId: string,
  issuanceId: string | null,
): Promise<{ wording: AppliedWording; lender: AnyDealDocumentData["lender"] } | null> {
  if (!issuanceId) return null
  const issuance = await db.assetDocumentIssuance.findFirst({ where: { id: issuanceId, tenantId } })
  if (!issuance) return null
  const version = await db.documentTemplateVersion.findFirst({ where: { id: issuance.templateVersionId, templateId: issuance.templateId } })
  if (!version?.content || contentSha256(version.content) !== issuance.templateContentSha256) {
    throw new DealDocumentError("The issued template version does not match its recorded hash")
  }
  // Parsed, not re-validated: the version was valid when issued, and a later
  // rule change must not stop a signer signing what they were shown.
  const content = parseContent(version.content)
  if (!content) throw new DealDocumentError("The issued template version is not readable")
  return {
    wording: issuedWording({ templateKey: issuance.templateKey, content, approvalBasis: issuance.approvalBasis }),
    lender: issuance.lenderIdentity as unknown as AnyDealDocumentData["lender"],
  }
}

/** Read a retained input snapshot back (evidence and reproduction). */
export async function readIssuanceInput(storagePath: string, expectedSha256: string): Promise<RenderInput> {
  const bytes = await readFile(storagePath)
  if (sha256DocumentBytes(bytes) !== expectedSha256) throw new DealDocumentError("The retained render input failed its integrity check")
  return deserializeRenderInput(bytes)
}
