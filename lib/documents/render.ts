import { prisma } from "@/lib/prisma"
import { saveFile } from "@/lib/storage"
import { SYSTEM_GENERATORS, type SystemDocContext } from "@/lib/documents/catalogue"
import { renderTokens, type TokenContext } from "@/lib/documents/tokens"
import { findLenderIdentity } from "@/lib/config/identity"
import { htmlToPdf } from "@/lib/documents/html-to-pdf"

/**
 * Thrown when a CUSTOM template's rendered HTML still contains one or more
 * unresolved `{{token}}` placeholders (no loan/application/staff in context,
 * or a client field that isn't on file). This is the empty-token guard: a
 * legal document must never be generated with a silent blank field, so
 * `generateDocument` throws instead of persisting anything.
 */
export class MissingTokenError extends Error {
  missing: string[]

  constructor(missing: string[]) {
    super(`Cannot generate document: missing token value(s): ${missing.join(", ")}`)
    this.name = "MissingTokenError"
    this.missing = missing
  }
}

/** Thrown when a CUSTOM template is not currently safe to generate. */
export class TemplateUnavailableError extends Error {
  constructor(templateKey: string) {
    super(`Document template is not published and available: ${templateKey}`)
    this.name = "TemplateUnavailableError"
  }
}

/**
 * Thrown when `generateDocument` is called with `allowSystem: false` (the
 * generic `POST /api/documents/generate` route) against a SYSTEM template.
 * SYSTEM documents (credit agreement, Section 129) carry NCA-mandated
 * legal content and MUST only be generated via their dedicated, higher-role
 * routes (`app/api/applications/[id]/agreement/route.ts` = CREDIT_OFFICER,
 * `app/api/loans/section129/route.ts` = COLLECTIONS_OFFICER) — not the
 * READONLY-gated generic route, which would otherwise bypass those gates.
 */
export class SystemGenerationNotAllowedError extends Error {
  constructor(templateKey: string) {
    super(`Template "${templateKey}" is a SYSTEM document and cannot be generated via this path`)
    this.name = "SystemGenerationNotAllowedError"
  }
}

/**
 * Generates a document from a catalogue template (SYSTEM or CUSTOM),
 * persists it as a `ClientDocument`, and logs a POPIA `DocumentAccessLog`
 * "generated" row — the same storage + access-log pattern used by
 * `app/api/applications/[id]/agreement/route.ts` (saveFile → clientDocument
 * .create) and `app/api/documents/[id]/view/route.ts` (documentAccessLog
 * .create). Every query against a tenant-scoped model passes `tenantId`
 * explicitly in `where`/`data`: callers (e.g.
 * `app/api/documents/generate/route.ts`) do run this inside an ambient
 * `withTenantContext` frame, so the tenant-scope extension would inject
 * `tenantId` automatically anyway — the explicit `tenantId` here is
 * defense-in-depth, not a substitute for that frame. `User` is excluded
 * from tenant-scope auto-injection entirely, so its query below is
 * filtered by hand too.
 */
export async function generateDocument(opts: {
  tenantId: string
  templateKey: string
  clientId: string
  loanId?: string
  applicationId?: string
  staffUserId?: string
  allowSystem?: boolean
}): Promise<{ clientDocumentId: string; buffer: Buffer }> {
  const { tenantId, templateKey, clientId, loanId, applicationId, staffUserId } = opts
  const allowSystem = opts.allowSystem ?? true

  const template = await prisma.documentTemplate.findFirst({
    where: { tenantId, key: templateKey, deletedAt: null },
  })
  if (!template) {
    throw new Error(`Document template not found: tenant=${tenantId} key=${templateKey}`)
  }
  if (template.kind === "SYSTEM" && !allowSystem) {
    throw new SystemGenerationNotAllowedError(templateKey)
  }
  // Asset-finance legal wording is issued only with its deal documents
  // (lib/asset-finance/documents/templates/issuance.ts), never as a letter.
  if (template.kind === "ASSET_FINANCE") {
    throw new TemplateUnavailableError(template.key)
  }

  if (template.kind === "CUSTOM" && (!template.isActive || !template.currentVersionId)) {
    throw new TemplateUnavailableError(template.key)
  }

  const activeVersion = template.kind === "CUSTOM"
    ? await prisma.documentTemplateVersion.findFirst({
        where: { id: template.currentVersionId!, templateId: template.id, status: "ACTIVE" },
      })
    : null
  if (template.kind === "CUSTOM" && !activeVersion) {
    throw new TemplateUnavailableError(template.key)
  }

  const client = await prisma.client.findFirst({ where: { id: clientId, tenantId } })
  if (!client) {
    throw new Error(`Client not found: ${clientId}`)
  }

  const loan = loanId
    ? await prisma.loan.findFirst({ where: { id: loanId, tenantId, clientId } })
    : null
  if (loanId && !loan) {
    throw new Error(`Loan not found: ${loanId}`)
  }

  const application = applicationId
    ? await prisma.loanApplication.findFirst({
        where: { id: applicationId, tenantId, clientId },
        include: { product: true },
      })
    : null
  if (applicationId && !application) {
    throw new Error(`Application not found: ${applicationId}`)
  }

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } })
  if (!tenant) {
    throw new Error(`Tenant not found: ${tenantId}`)
  }

  // User is excluded from TENANT_SCOPED_MODELS — filter by hand. Unlike
  // client/loan/application, an unresolved staffUserId doesn't throw: it
  // only feeds the `staff.name` token (falls back to "missing" via the
  // empty-token guard), while `ClientDocument.uploadedById` below is stamped
  // straight from `opts.staffUserId` regardless.
  const staff = staffUserId
    ? await prisma.user.findFirst({ where: { id: staffUserId, tenantId } })
    : null

  let buffer: Buffer
  let generatedFromVersionId: string | null = null

  if (template.kind === "SYSTEM") {
    const generatorKey = template.systemGenerator
    const generator = generatorKey ? SYSTEM_GENERATORS[generatorKey] : undefined
    if (!generator) {
      throw new Error(`No SYSTEM_GENERATORS entry for "${generatorKey}"`)
    }
    const ctx: SystemDocContext = { tenant, client, loan, application }
    buffer = await generator(ctx)
  } else {
    const lender = await findLenderIdentity(tenantId)
    const ctx: TokenContext = { tenant, lender, client, application, loan, staff }
    const { html, missing } = renderTokens(activeVersion!.bodyHtml, ctx)
    if (missing.length > 0) {
      throw new MissingTokenError(missing)
    }

    buffer = await htmlToPdf(html)
    generatedFromVersionId = activeVersion!.id
  }

  const { storagePath, fileSize } = await saveFile(buffer, "application/pdf")

  const clientDocument = await prisma.clientDocument.create({
    data: {
      tenantId,
      clientId,
      docType: "OTHER",
      fileName: `${template.name}.pdf`,
      fileUrl: "",
      storagePath,
      fileSize,
      mimeType: "application/pdf",
      uploadedByType: "staff",
      uploadedById: staffUserId ?? null,
      templateId: template.id,
      generatedFromVersionId,
      extractionStatus: "skipped",
      verified: false,
    },
  })

  // No tenantId column on DocumentAccessLog (see prisma/schema/clients-kyc.prisma).
  // accessorId falls back to "system" when no staff member drove this
  // generation (e.g. a cron-triggered SYSTEM document) — the column is
  // NOT NULL and there is no acting user id to record.
  await prisma.documentAccessLog.create({
    data: {
      documentId: clientDocument.id,
      accessorType: "staff",
      accessorId: staffUserId ?? "system",
      action: "generated",
    },
  })

  return { clientDocumentId: clientDocument.id, buffer }
}
