import type { LoanDocumentKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { findLenderIdentity } from "@/lib/config/identity"
import { ensureActiveJurisdiction } from "@/lib/jurisdiction/load.server"
import { htmlToPdf } from "@/lib/documents/html-to-pdf"
import { MissingTokenError, TemplateUnavailableError } from "@/lib/documents/render"
import { renderTokens, type TokenContext } from "@/lib/documents/tokens"
import { escapeHtmlText } from "@/lib/non-nca-documents/html"
import { sha256Text } from "@/lib/affordability/snapshot"
import { LOAN_DOCUMENT_TEMPLATE_KEYS, SAMPLE_BANNER_TEXT } from "./keys"
import { quoteFor } from "./quote"

export interface RenderedLoanDocument {
  kind: LoanDocumentKind
  templateId: string
  templateKey: string
  versionId: string
  versionNumber: number
  /** SHA-256 of the version's bodyHtml: what the database gate recomputes. */
  templateContentSha256: string
  pdf: Buffer
  sample: boolean
}

/**
 * Renders one of the lender's two loan documents for an application, from the
 * current approved version of its template and the approved terms. Nothing is
 * stored here. A template that is missing, not in use, without an approved
 * current version or with an unresolved token refuses (TemplateUnavailableError,
 * MissingTokenError): a legal document is never printed with a silent blank.
 * A demo lender's document opens with the SAMPLE banner.
 */
export async function renderLoanDocument(args: {
  tenantId: string
  applicationId: string
  kind: LoanDocumentKind
  staffUserId: string | null
}): Promise<RenderedLoanDocument> {
  const { tenantId, applicationId, kind } = args
  // Every amount below is printed in the instance's currency: know it before formatting anything.
  await ensureActiveJurisdiction()
  const key = LOAN_DOCUMENT_TEMPLATE_KEYS[kind]
  const template = await prisma.documentTemplate.findFirst({ where: { tenantId, key, deletedAt: null } })
  if (!template || template.kind !== "CUSTOM" || !template.isActive || !template.currentVersionId) {
    throw new TemplateUnavailableError(key)
  }
  const version = await prisma.documentTemplateVersion.findFirst({
    where: { id: template.currentVersionId, templateId: template.id, status: "ACTIVE" },
  })
  if (!version || (template.requiresApproval && (!version.approvedById || !version.approvedAt))) {
    throw new TemplateUnavailableError(key)
  }

  const application = await prisma.loanApplication.findFirst({
    where: { id: applicationId, tenantId },
    include: { product: true, client: true },
  })
  if (!application?.client) throw new Error(`Application not found: ${applicationId}`)
  const [tenant, config, lender, staff] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } }),
    findLenderIdentity(tenantId),
    args.staffUserId ? prisma.user.findFirst({ where: { id: args.staffUserId, tenantId } }) : null,
  ])
  const quote = quoteFor(application)
  const ctx: TokenContext = { tenant, lender, client: application.client, application, staff, quote }
  const { html, missing } = renderTokens(version.bodyHtml, ctx)
  if (missing.length > 0) throw new MissingTokenError(missing)

  const sample = config?.isDemoLender === true
  const banner = sample
    ? `<p style="border:2px solid #b45309;color:#b45309;font-weight:bold;text-align:center;padding:8px;margin:0 0 16px">${escapeHtmlText(SAMPLE_BANNER_TEXT)}</p>`
    : ""
  return {
    kind,
    templateId: template.id,
    templateKey: key,
    versionId: version.id,
    versionNumber: version.version,
    templateContentSha256: sha256Text(version.bodyHtml),
    pdf: await htmlToPdf(banner + html),
    sample,
  }
}
