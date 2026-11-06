import { createHash } from "node:crypto"
import type { LoanProduct, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { findLenderIdentity } from "@/lib/config/identity"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import { calculateLoan, type LoanCalcInput } from "@/lib/loan-calculator"
import { previewCalcInput } from "@/lib/product-engine/approval-terms"
import { CUSTOMER_PRODUCT_WHERE } from "@/lib/product-config/product-kind"
import { deleteFile, saveFile } from "@/lib/storage"
import { formatDate, formatZAR } from "@/lib/utils"
import { LOAN_DOCUMENT_TEMPLATE_KEYS } from "./keys"
import { quoteFromCalculation } from "./quote"
import { currentApprovedTemplate, renderedPdf } from "./render"

const INDICATIVE_NOTICE = "INDICATIVE — before you apply. Approval sets the final figures."
const REFERENCE_BEFORE_APPLYING = "Not yet applied"
/** A statement stands for the application made from it this long: pricing can move. */
const SHOWN_WITHIN_MS = 24 * 60 * 60 * 1000

export type IndicativeKeyFactsResult =
  | {
      ok: true; documentId: string; sha256: string; viewUrl: string
      figures: { amount: string; instalments: number; instalment: string; totalRepayable: string; totalCostOfCredit: string; firstDueDate: string }
    }
  | { ok: false; status: 400 | 404 | 422; error: string }

/** What the statement was rendered for, read back when the application is submitted. */
interface IndicativeTerms { indicativeKeyFacts: { productId: string; amountCents: number; termDays: number } }

type Actor = { type: "client"; clientId: string; email: string | null } | { type: "staff"; id: string; email: string }

/**
 * Tender 2.2.4: before an application is submitted, the borrower sees the lender's own key facts statement for the exact
 * amount and term, from its current approved template, with the same calculator a submission snapshot uses. Stored as the
 * borrower's document and audited. It carries the INDICATIVE banner: the figures that bind are the approved ones, on the
 * statement issued after approval (issue.ts). Submission refuses without one for exactly these terms: the portal's route,
 * and staff submitting a draft (a branch borrower is shown it there). Every other channel is refused on a key-facts
 * instance (submission-channels.test.ts holds the census). Once an application claims it, the database keeps its file.
 */
export async function issueIndicativeKeyFacts(args: {
  tenantId: string
  clientId: string
  actor: Actor
  /** The portal: a product on sale, by code, and the term asked for (a fixed-term product needs none). */
  productCode: string
  amountCents: number
  termDays: number | undefined
  ipAddress?: string
}): Promise<IndicativeKeyFactsResult> {
  const { tenantId, amountCents } = args
  const product = await prisma.loanProduct.findFirst({ where: { tenantId, code: args.productCode, active: true, ...CUSTOMER_PRODUCT_WHERE } })
  if (!product) return { ok: false, status: 422, error: "This loan product is not currently available." }
  if (amountCents < product.minAmount || amountCents > product.maxAmount) return { ok: false, status: 400, error: "The amount is outside this product's range." }
  const termDays = product.minTermDays === product.maxTermDays ? product.minTermDays : args.termDays
  if (!termDays || termDays < product.minTermDays || termDays > product.maxTermDays) return { ok: false, status: 400, error: "The term is outside this product's range." }
  return renderAndStore({ ...args, product, termDays, calc: {
    principal: amountCents, termDays, interestRatePm: product.interestRatePm, productType: product.productType, interestModel: product.interestModel,
    initiationFeeModel: product.initiationFeeModel, initiationFeePct: product.initiationFeePct, initiationFeeMax: product.initiationFeeMax, monthlyServiceFee: product.monthlyServiceFee,
  } })
}

/** The same statement for a staff draft, on the draft's own client, product and terms, priced as approval would price it. */
export async function issueIndicativeKeyFactsForDraft(args: { tenantId: string; applicationId: string; staff: { id: string; email: string }; ipAddress?: string }): Promise<IndicativeKeyFactsResult> {
  const { tenantId, applicationId } = args
  const application = await prisma.loanApplication.findFirst({ where: { id: applicationId, tenantId }, include: { product: true } })
  if (!application) return { ok: false, status: 404, error: "Application not found" }
  if (application.disclosureRegime !== "KEY_FACTS" || !application.clientId) return { ok: false, status: 400, error: "This application has no key facts statement" }
  if (application.status !== "DRAFT") return { ok: false, status: 400, error: "The statement before submission is for a draft" }
  const calc = await previewCalcInput(prisma, tenantId, application, application.product)
  return renderAndStore({
    tenantId, clientId: application.clientId, actor: { type: "staff", ...args.staff }, product: application.product, amountCents: application.appliedAmount, termDays: application.appliedTermDays, calc,
    productCode: application.product.code, ipAddress: args.ipAddress,
  })
}

async function renderAndStore(args: {
  tenantId: string
  clientId: string
  actor: Actor
  product: Pick<LoanProduct, "id" | "name" | "regulatorApprovalRef">
  productCode: string
  amountCents: number
  termDays: number
  calc: LoanCalcInput
  ipAddress?: string
}): Promise<IndicativeKeyFactsResult> {
  const { tenantId, clientId, amountCents, termDays, product, actor } = args
  const [client, tenant, config, lender] = await Promise.all([
    prisma.client.findFirst({ where: { id: clientId, tenantId } }),
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } }),
    prisma.tenantConfig.findUnique({ where: { tenantId }, select: { isDemoLender: true } }),
    findLenderIdentity(tenantId),
  ])
  if (!client) return { ok: false, status: 404, error: "Client record not found." }
  const calculation = calculateLoan(args.calc, new Date())
  if (calculation.schedule.length === 0) return { ok: false, status: 422, error: "These terms produce no repayment schedule." }
  const quote = quoteFromCalculation(calculation, { termDays, interestRatePm: args.calc.interestRatePm }, "EFT")

  const key = LOAN_DOCUMENT_TEMPLATE_KEYS.KEY_FACTS_STATEMENT
  const { template, version } = await currentApprovedTemplate(tenantId, key)
  const application = { reference: REFERENCE_BEFORE_APPLYING, appliedAmount: amountCents, product: { name: product.name, regulatorApprovalRef: product.regulatorApprovalRef } } as unknown as NonNullable<Parameters<typeof renderedPdf>[1]["application"]>
  const pdf = await renderedPdf(version.bodyHtml, { tenant, lender, client, application, quote }, config?.isDemoLender === true, INDICATIVE_NOTICE)
  const sha256 = createHash("sha256").update(pdf).digest("hex")
  const file = await saveFile(pdf, "application/pdf")
  const terms: IndicativeTerms = { indicativeKeyFacts: { productId: product.id, amountCents, termDays } }
  const documentId = await prisma.$transaction(async (tx) => {
    const document = await tx.clientDocument.create({
      data: {
        tenantId, clientId, docType: "OTHER", fileName: `key-facts-indicative-${args.productCode}.pdf`, fileUrl: "", storagePath: file.storagePath, fileSize: file.fileSize,
        mimeType: "application/pdf", uploadedByType: actor.type === "staff" ? "staff" : "system", uploadedById: actor.type === "staff" ? actor.id : null, templateId: template.id, generatedFromVersionId: version.id, contentSha256: sha256,
        extractionStatus: "skipped", extractionResult: terms as unknown as Prisma.InputJsonValue, verified: false,
      },
    })
    await tx.clientDocument.update({ where: { id: document.id }, data: { fileUrl: `/api/documents/${document.id}/view` } })
    await tx.documentAccessLog.create({ data: { documentId: document.id, accessorType: actor.type, accessorId: actor.type === "staff" ? actor.id : clientId, action: "generated" } })
    await logAuditStrict({
      tenantId, ...(actor.type === "staff" ? { userId: actor.id } : {}), userEmail: actor.email ?? undefined, action: AuditAction.KEY_FACTS_QUOTED, entity: "Client", entityId: clientId,
      newValue: { actor: actor.type === "staff" ? { type: "staff", id: actor.id } : { type: "client", clientId }, documentId: document.id, pdfSha256: sha256, templateVersion: version.version, ...terms.indicativeKeyFacts },
      ipAddress: args.ipAddress,
    }, tx)
    return document.id
  }).catch(async (error: unknown) => {
    await deleteFile(file.storagePath).catch(() => undefined)
    throw error
  })
  return {
    ok: true, documentId, sha256, viewUrl: `/api/documents/${documentId}/view`,
    figures: {
      amount: formatZAR(amountCents), instalments: quote.instalments, instalment: formatZAR(quote.monthlyInstalmentCents), totalRepayable: formatZAR(quote.totalRepayableCents),
      totalCostOfCredit: formatZAR(quote.totalRepayableCents - amountCents), firstDueDate: formatDate(quote.firstDueDate),
    },
  }
}

/**
 * The document proving the applicant was shown the statement for these exact terms, or null: theirs, recent, not spent on
 * another application, from the template the lender still publishes. The submitting transaction claims it.
 */
export async function indicativeKeyFactsShown(
  tx: Pick<typeof prisma, "clientDocument" | "documentTemplate">,
  args: { tenantId: string; clientId: string; sha256: unknown; productId: string; amountCents: number; termDays: number },
): Promise<string | null> {
  const { tenantId, clientId, sha256 } = args
  if (!isSha256Digest(sha256)) return null
  const template = await tx.documentTemplate.findFirst({ where: { tenantId, key: LOAN_DOCUMENT_TEMPLATE_KEYS.KEY_FACTS_STATEMENT, deletedAt: null }, select: { id: true, currentVersionId: true } })
  if (!template?.currentVersionId) return null
  const document = await tx.clientDocument.findFirst({
    where: {
      tenantId, clientId, contentSha256: sha256, deletedAt: null, issuedForApplicationId: null, templateId: template.id, generatedFromVersionId: template.currentVersionId,
      createdAt: { gte: new Date(Date.now() - SHOWN_WITHIN_MS) },
    },
    select: { id: true, extractionResult: true },
  })
  const terms = (document?.extractionResult as IndicativeTerms | null)?.indicativeKeyFacts
  if (!document || terms?.productId !== args.productId || terms.amountCents !== args.amountCents || terms.termDays !== args.termDays) return null
  return document.id
}

/** For the channels with no statement step: the public form, a lead's conversion, asset finance. */
export const KEY_FACTS_CHANNEL_REFUSAL = "This lender's borrowers read a key facts statement before applying, and this channel cannot show one."
/** Staff capture keeps its gate: save the draft, then submit it from its page, where the statement for its terms is shown. */
export const KEY_FACTS_STAFF_REFUSAL = "Save the draft, then submit it from the application page once the borrower has read the key facts statement for these terms."
